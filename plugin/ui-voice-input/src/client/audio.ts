/**
 * Microphone capture, waveform levels, WAV encoding, and local-Whisper
 * transcription. Self-contained browser helpers behind the voice button;
 * no Host or core dependency — audio is recorded in the page, encoded to a
 * 16-bit PCM WAV, and POSTed to the operator's local Whisper endpoint.
 */
/* oxlint-disable typescript/no-deprecated --
 * ScriptProcessorNode is the pragmatic PCM-capture path here: AudioWorklet
 * requires a separately-loaded module URL that the dynamic bundle cannot
 * supply cleanly, and MediaRecorder emits codecs (opus/webm) the local
 * Whisper servers do not decode. Deprecated but universally supported. */

/** Number of waveform bars the button renders while recording. */
export const WAVEFORM_BARS = 9

/**
 * Compute waveform bar levels (0..1) from an AnalyserNode time-domain buffer.
 * @param timeData - time-domain bytes (0..255, 128 = silence).
 * @param bars - number of bars to produce (default {@link WAVEFORM_BARS}).
 * @returns one level per bar; typical speech amplitude (~20–60) maps to 0.33–1.0.
 */
export function computeLevels(timeData: Uint8Array, bars: number = WAVEFORM_BARS): number[] {
  const levels: number[] = new Array<number>(bars)
  for (let i = 0; i < bars; i++) {
    const index = Math.floor((i * (timeData.length - 1)) / Math.max(1, bars - 1))
    const sample = timeData[index] ?? 128
    levels[i] = Math.min(1, Math.abs(sample - 128) / 60)
  }
  return levels
}

/** One live recording: resolve audio bytes on stop, or discard them on cancel. */
export interface VoiceRecorder {
  /** Stop capture and return the encoded WAV blob (idempotent per recording). */
  stop(): Promise<Blob>
  /** Stop capture and discard the audio (idempotent; no blob is produced). */
  cancel(): void
}

/** Distinguishes a transcription failure the button maps to product copy. */
export type TranscriptionFailure = 'server' | 'empty'

/** Transcription failure carrying the button's copy-kind. */
export class TranscriptionError extends Error {
  /**
   * @param kind - copy-kind of the failure ('server' unreachable/HTTP, 'empty' no text).
   */
  constructor(readonly kind: TranscriptionFailure) {
    super(`transcription failed: ${kind}`)
  }
}

/**
 * Begin capturing the default microphone and start reporting live waveform
 * levels (one 0..1 value per bar) once per animation frame.
 * @param onLevels - invoked every frame with the current bar levels.
 * @returns a recorder handle whose `stop` resolves the encoded WAV blob.
 */
export async function startVoiceRecording(onLevels: (levels: readonly number[]) => void): Promise<VoiceRecorder> {
  // Create the AudioContext synchronously inside the triggering user gesture
  // (before the first await) and resume it. An AudioContext created after
  // `await getUserMedia` can be left suspended by the browser autoplay policy,
  // which mutes both the analyser and the ScriptProcessor capturer — a dead
  // waveform and an empty transcription.
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
  analyser.fftSize = 64
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)

  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  // ScriptProcessorNode only fires while connected to a sink; route it through
  // a muted gain so the mic is never replayed to the speakers.
  const mute = context.createGain()
  mute.gain.value = 0
  processor.connect(mute)
  mute.connect(context.destination)

  const timeData = new Uint8Array(analyser.fftSize)
  let raf = 0
  const loop = (): void => {
    analyser.getByteTimeDomainData(timeData)
    onLevels(computeLevels(timeData))
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  let teardown: Promise<Blob> | null = null
  const finish = (): Promise<Blob> => {
    if (teardown !== null) return teardown
    teardown = (async () => {
      cancelAnimationFrame(raf)
      processor.onaudioprocess = null
      processor.disconnect()
      mute.disconnect()
      analyser.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => { track.stop() })
      await context.close()
      return encodeWav(concatFloat32(chunks), sampleRate)
    })()
    return teardown
  }

  return {
    stop: finish,
    cancel: () => { void finish() },
  }
}

/** Abort a browser fetch after this long so a hung server never strands the UI. */
const FETCH_TIMEOUT_MS = 30_000

/** Short timeout for the liveness probe. */
const HEALTH_TIMEOUT_MS = 3_000

/**
 * Check whether the local Whisper server is reachable (GET /health).
 * @param endpoint - the transcription endpoint (e.g. `http://127.0.0.1:9000/inference`).
 * @returns true when the server answers within a short timeout with an OK status.
 */
export async function checkWhisperHealth(endpoint: string): Promise<boolean> {
  const healthUrl = endpoint.replace(/\/inference\/?$/, '/health')
  const controller = new AbortController()
  const timer = window.setTimeout(() => { controller.abort() }, HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(healthUrl, { signal: controller.signal })
    window.clearTimeout(timer)
    return response.ok
  } catch (_networkFailure) {
    window.clearTimeout(timer)
    return false
  }
}

/**
 * POST one WAV blob to the local Whisper endpoint and return the trimmed text.
 * @param audio - encoded WAV audio.
 * @param endpoint - multipart transcription endpoint answering `{ text }`.
 * @param language - optional two-letter transcription language (empty = server auto-detect).
 * @returns the recognized text.
 * @throws {TranscriptionError} on network/HTTP failure or an empty result.
 */
export async function transcribe(audio: Blob, endpoint: string, language = ''): Promise<string> {
  const form = new FormData()
  form.append('file', audio, 'voice.wav')
  if (language.trim() !== '') form.append('language', language.trim())
  const controller = new AbortController()
  const timer = window.setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal })
  } catch (_networkFailure) {
    throw new TranscriptionError('server')
  } finally {
    window.clearTimeout(timer)
  }
  if (!response.ok) throw new TranscriptionError('server')
  let payload: unknown
  try {
    payload = await response.json()
  } catch (_invalidJson) {
    throw new TranscriptionError('server')
  }
  const text = (payload as { text?: unknown } | null)?.text
  if (typeof text !== 'string' || text.trim() === '') throw new TranscriptionError('empty')
  return text.trim()
}

/**
 * Ask the local Whisper server's `/clean` route to clean a transcription with the
 * configured LLM and optional conversation context. Best-effort: on any failure
 * the raw text is returned unchanged.
 * @param text - the raw transcription.
 * @param context - optional recent-conversation context for the cleanup model.
 * @param endpoint - the transcription endpoint (the `/clean` route is derived from it).
 * @param apiKey - optional OpenAI-compatible API key (sent per request).
 * @param model - optional cleanup model name (sent per request).
 * @param effort - optional cleanup reasoning effort (off/low/high/max; sent per request).
 * @returns the cleaned text (or the raw text when cleanup is unavailable).
 */
export async function cleanTranscript(text: string, context: string, endpoint: string, apiKey = '', model = '', effort = ''): Promise<string> {
  const cleanUrl = endpoint.replace(/\/inference\/?$/, '/clean')
  const controller = new AbortController()
  const timer = window.setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('text', text)
    if (context.trim() !== '') form.append('context', context.trim())
    if (apiKey.trim() !== '') form.append('api_key', apiKey.trim())
    if (model.trim() !== '') form.append('model', model.trim())
    if (effort.trim() !== '') form.append('reasoning_effort', effort.trim())
    const response = await fetch(cleanUrl, { method: 'POST', body: form, signal: controller.signal })
    if (!response.ok) return text
    const payload = (await response.json()) as { text?: unknown }
    return typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text.trim() : text
  } catch (_networkFailure) {
    return text
  } finally {
    window.clearTimeout(timer)
  }
}

/** Concatenate captured mono PCM chunks into one interleaved buffer. */
function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const samples = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  return samples
}
/**
 * Encode mono float samples as a 16-bit PCM WAV blob.
 * @param samples - interleaved mono samples in [-1, 1].
 * @param sampleRate - the sample rate in Hz.
 * @returns a WAV blob with a 16-bit PCM payload.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
