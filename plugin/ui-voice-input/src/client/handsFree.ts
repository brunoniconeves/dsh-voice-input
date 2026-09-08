/**
 * Hands-free capture: the microphone stays open and on, a lightweight
 * voice-activity detector (adaptive noise floor) finds spoken utterances, each
 * utterance is encoded to WAV and transcribed by the local Whisper endpoint,
 * and the resulting text is handed to a callback. Designed for the
 * always-listening command loop — Whisper runs only when the user actually
 * speaks, not continuously.
 */
/* oxlint-disable typescript/no-deprecated --
 * ScriptProcessorNode is the pragmatic PCM-capture path here (see audio.ts). */

import { computeLevels, encodeWav, transcribe } from './audio.ts'

/** One live hands-free session: dispose stops the mic and the loop. */
export interface HandsFreeHandle {
  /** Stop capture, close the audio graph, and release the microphone. */
  dispose(): Promise<void>
}

/** Consecutive loud frames before an utterance starts. */
const SPEECH_START_FRAMES = 4
/** Consecutive quiet frames before the current utterance is considered over (~1 s): long
 * enough to keep a natural phrase together instead of splitting at every small pause. */
const SPEECH_END_FRAMES = 60
/** A captured utterance shorter than this (ms) is treated as a noise blip. */
const MIN_UTTERANCE_MS = 320
/** A runaway utterance is force-ended after this long (ms). */
const MAX_UTTERANCE_MS = 20_000
/** Noise-floor EMA factor (per frame); a slower phone/room floor adapts smoothly. */
const NOISE_EMA = 0.97
/** Start threshold as a multiple of the calibrated noise floor. */
const START_RATIO = 2.6
/** End threshold as a multiple of the calibrated noise floor. */
const END_RATIO = 1.7
/** Absolute floors so a very quiet mic still has a usable threshold. */
const FLOOR_START = 0.015
const FLOOR_END = 0.009
/** Upper bound on the session ring buffer (~30 s), so an open mic never grows unbounded. */
const MAX_BUFFER_SAMPLES = 30 * 48_000
const PROCESSOR_SIZE = 4096
const TWO_PROCESSOR_LEAD = PROCESSOR_SIZE * 2

/**
 * Begin hands-free listening. The AudioContext is created synchronously (within
 * the enabling user gesture) and resumed so the autoplay policy does not
 * suspend it.
 * @param onUtterance - invoked with each transcribed spoken utterance.
 * @param getEndpoint - resolves the local Whisper endpoint per utterance.
 * @param getLanguage - resolves the transcription language per utterance ('' = auto).
 * @param onLevels - invoked each frame with the waveform levels.
 * @param onProcessing - invoked when a transcription starts (true) and settles (false).
 * @returns a handle whose `dispose` releases the microphone.
 */
export async function startHandsFree(
  onUtterance: (text: string) => void,
  getEndpoint: () => string,
  getLanguage: () => string,
  onLevels: (levels: readonly number[]) => void = () => {},
  onProcessing: (processing: boolean) => void = () => {},
): Promise<HandsFreeHandle> {
  const context = new AudioContext()
  await context.resume()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (error) {
    await context.close()
    throw error
  }
  const sampleRate = context.sampleRate
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)

  const processor = context.createScriptProcessor(PROCESSOR_SIZE, 1, 1)
  const chunks: Float32Array[] = []
  let bufferStartSample = 0
  let totalSamples = 0
  processor.onaudioprocess = (event) => {
    const data = new Float32Array(event.inputBuffer.getChannelData(0))
    chunks.push(data)
    totalSamples += data.length
    while (chunks.length > 0 && totalSamples - bufferStartSample > MAX_BUFFER_SAMPLES) {
      const dropped = chunks.shift()
      if (dropped === undefined) break
      bufferStartSample += dropped.length
    }
  }
  source.connect(processor)
  const mute = context.createGain()
  mute.gain.value = 0
  processor.connect(mute)
  mute.connect(context.destination)

  const timeData = new Uint8Array(analyser.fftSize)
  let raf = 0
  let speaking = false
  let speechFrames = 0
  let silenceFrames = 0
  let utteranceStartSamples = 0
  let utteranceStartTime = 0
  let noiseRms = 0.02
  let disposed = false

  const endUtterance = (): void => {
    const start = utteranceStartSamples
    const end = totalSamples
    utteranceStartSamples = end
    if (end - start < sampleRate * (MIN_UTTERANCE_MS / 1000)) return
    const audio = encodeWav(sliceChunks(chunks, bufferStartSample, start, end - start), sampleRate)
    onProcessing(true)
    void transcribe(audio, getEndpoint(), getLanguage())
      .then(onUtterance)
      .catch(() => { /* a failed burst is dropped silently; the next utterance retries */ })
      .finally(() => { onProcessing(false) })
  }

  const loop = (): void => {
    if (disposed) return
    analyser.getByteTimeDomainData(timeData)
    onLevels(computeLevels(timeData))
    let sum = 0
    for (let i = 0; i < timeData.length; i++) {
      const x = ((timeData[i] ?? 128) - 128) / 128
      sum += x * x
    }
    const rms = Math.sqrt(sum / timeData.length)
    if (!speaking) {
      // Calibrate the ambient noise floor while idle; thresholds are relative
      // to it, so a noisy room does not keep the detector "in speech".
      noiseRms = noiseRms * NOISE_EMA + rms * (1 - NOISE_EMA)
      const startThreshold = Math.max(FLOOR_START, noiseRms * START_RATIO)
      speechFrames = rms > startThreshold ? speechFrames + 1 : 0
      if (speechFrames >= SPEECH_START_FRAMES) {
        speaking = true
        silenceFrames = 0
        utteranceStartSamples = Math.max(bufferStartSample, totalSamples - TWO_PROCESSOR_LEAD)
        utteranceStartTime = performance.now()
      }
    } else {
      const endThreshold = Math.max(FLOOR_END, noiseRms * END_RATIO)
      if (rms < endThreshold) {
        silenceFrames += 1
        if (silenceFrames >= SPEECH_END_FRAMES) {
          speaking = false
          speechFrames = 0
          silenceFrames = 0
          endUtterance()
        }
      } else {
        silenceFrames = 0
      }
      if (speaking && performance.now() - utteranceStartTime > MAX_UTTERANCE_MS) {
        speaking = false
        speechFrames = 0
        silenceFrames = 0
        endUtterance()
      }
    }
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  return {
    async dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(raf)
      processor.onaudioprocess = null
      processor.disconnect()
      mute.disconnect()
      analyser.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => { track.stop() })
      await context.close()
    },
  }
}

/** Concatenate the recorded PCM samples in the half-open [startSamples, startSamples+count). */
function sliceChunks(
  chunks: readonly Float32Array[],
  bufferStartSample: number,
  startSamples: number,
  count: number,
): Float32Array {
  const out = new Float32Array(count)
  let outOffset = 0
  let base = bufferStartSample
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as Float32Array
    const chunkStart = base
    const chunkEnd = base + chunk.length
    if (chunkEnd <= startSamples) {
      base = chunkEnd
      continue
    }
    if (chunkStart >= startSamples + count) break
    const from = Math.max(0, startSamples - chunkStart)
    const to = Math.min(chunk.length, startSamples + count - chunkStart)
    for (let j = from; j < to; j++) {
      out[outOffset++] = chunk[j] as number
    }
    base = chunkEnd
    if (outOffset >= count) break
  }
  return out
}
