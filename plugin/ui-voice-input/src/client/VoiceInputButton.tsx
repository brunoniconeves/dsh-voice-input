/**
 * VoiceInputButton: the composer's `conversation.input.right` voice control,
 * rendered just left of the send button. Two modes share one microphone:
 *
 * - Click mode (hands-free off): click to record, click again to stop and
 *   transcribe; the recognized text is appended to the draft.
 * - Hands-free mode (hands-free on): the mic stays on, an RMS voice-activity
 *   detector captures each spoken utterance, and the configured voice commands
 *   drive the loop — "listen" begins capturing, "send" submits the prompt, and
 *   "stop" keeps the captured text as a draft.
 *
 * Right-click opens a context menu with a "Configs" item that launches the
 * settings modal. Copy rides the standard locale seat; data and verbs arrive
 * through the framework standard kit (useInput/inputActions) and the injected
 * settings source.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import {
  IconWarningOutline16, Toast, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right seat) and
// the SessionStandardProps members (useInput/inputActions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  WAVEFORM_BARS, startVoiceRecording, transcribe, cleanTranscript, checkWhisperHealth,
  TranscriptionError, type VoiceRecorder,
} from './audio.ts'
import { classify, type CommandConfig, type CommandKind } from './commandMachine.ts'
import {
  DEFAULT_LISTEN_COMMAND, DEFAULT_SEND_COMMAND, DEFAULT_STOP_COMMAND,
} from '../voice-settings.ts'
import { ConfigModal } from './ConfigModal.tsx'
import { startHandsFree as beginHandsFree, type HandsFreeHandle } from './handsFree.ts'
import type { VoiceInputInjected } from './slots.ts'
import css from './VoiceInputButton.module.css'

/** Full composer-seat props: runtime share + injected face + the voice locale seat. */
type VoiceInputProps = PropsRuntime<'conversation.input.right'> & InjectFace<VoiceInputInjected> & PropsLocale<'voice'>

/** Click-mode recording lifecycle. */
type Phase = 'idle' | 'recording' | 'transcribing'

/** Flat resting floor so the button's layout reserves the waveform's height. */
const IDLE_LEVELS = Object.freeze<readonly number[]>(Array<number>(WAVEFORM_BARS).fill(0.06))

/** Minimal structural view of the session snapshot for conversation-context extraction. */
interface ContextSnapshot {
  chat?: {
    nodes?: {
      values?: () => readonly { kind: string; content?: readonly { type: string; text?: string }[] }[]
    }
  }
}

/** Build a compact recent-conversation context (last few user/assistant text messages). */
function conversationContext(snapshot: ContextSnapshot): string {
  const nodes = snapshot.chat?.nodes?.values?.() ?? []
  const lines: string[] = []
  for (const node of nodes) {
    if (node.kind !== 'user' && node.kind !== 'assistant') continue
    const text = (node.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join(' ')
      .trim()
    if (text !== '') lines.push(`${node.kind}: ${text}`)
  }
  return lines.slice(-8).join('\n').slice(-2_000)
}

/**
 * Render the composer voice control.
 * @param props - standard kit + injected settings/endpoint + the voice locale seat.
 * @returns the mic button, its optional waveform, the context menu, and the config modal.
 */
export function VoiceInputButton({
  useSession, sessionId, useInput, inputActions, useVoiceSettings, getEndpoint, setSettings, getModels, t,
}: VoiceInputProps) {
  const sessionSnapshot = useSession(s => s)
  const sessionRef = useRef(sessionSnapshot)
  sessionRef.current = sessionSnapshot
  const inputState = useInput(s => s)
  const draftRef = useRef(inputState.draft)
  draftRef.current = inputState.draft

  const settings = useVoiceSettings(s => s)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const [phase, setPhase] = useState<Phase>('idle')
  const [levels, setLevels] = useState<readonly number[]>(IDLE_LEVELS)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [serverDown, setServerDown] = useState(false)
  const processingCountRef = useRef(0)
  const [heard, setHeard] = useState<{ seq: number; text: string; kind: CommandKind } | null>(null)
  const heardSeq = useRef(0)
  const toastSeq = useRef(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const handsFreeRef = useRef<HandsFreeHandle | null>(null)
  const capturedRef = useRef<string[]>([])
  const capturingRef = useRef(false)
  capturingRef.current = capturing

  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuPosition = useAnchoredPosition({
    open: menuOpen,
    anchorRef: buttonRef,
    panelRef: menuRef,
    gap: 4,
    margin: 8,
  })
  useDismissOnOutsidePointer(rootRef, menuOpen, setMenuOpen)

  const showError = (text: string): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }

  // Append rather than replace: join on whatever is already in the draft, adding
  // a single separator when the draft is mid-word.
  const appendToDraft = (text: string): void => {
    const separator = draftRef.current === '' || /\s$/.test(draftRef.current) ? '' : ' '
    inputActions.setDraft(draftRef.current + separator + text)
  }

  // Track concurrent in-flight operations so the button shows a loading spinner
  // while the loop transcribes an utterance or runs the cleanup LLM call.
  const handleProcessing = (delta: number): void => {
    processingCountRef.current += delta
    if (processingCountRef.current < 0) processingCountRef.current = 0
    setProcessing(processingCountRef.current > 0)
  }

  // Append a transcription, optionally cleaned by the configured LLM using the
  // recent-conversation context. Best-effort: cleanup failure keeps the raw text.
  const appendTranscript = async (text: string): Promise<void> => {
    let final = text
    const current = settingsRef.current
    if (current.cleanup) {
      handleProcessing(1)
      try {
        final = await cleanTranscript(
          text,
          conversationContext(sessionRef.current),
          current.endpoint,
          current.cleanupApiKey,
          current.cleanupModel,
          current.cleanupEffort,
        )
      } finally {
        handleProcessing(-1)
      }
    }
    appendToDraft(final)
  }

  // ── click mode ────────────────────────────────────────────────────────────

  const stop = async (): Promise<void> => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder === null) return
    setPhase('transcribing')
    try {
      const audio = await recorder.stop()
      await appendTranscript(await transcribe(audio, getEndpoint(), settingsRef.current.language))
    } catch (error) {
      showError(error instanceof TranscriptionError
        ? t(error.kind === 'server' ? 'error.server' : 'error.empty')
        : t('error.transcribe'))
    } finally {
      setPhase('idle')
    }
  }

  const start = async (): Promise<void> => {
    try {
      const recorder = await startVoiceRecording(setLevels)
      recorderRef.current = recorder
      setPhase('recording')
    } catch (_micFailure) {
      showError(t('error.mic'))
    }
  }

  // ── hands-free loop ───────────────────────────────────────────────────────

  // Write everything accumulated since "start" into the composer (the LLM
  // prompt). This is NOT a send — submit is a separate command.
  const flushCapture = async (): Promise<void> => {
    const parts = capturedRef.current
    capturedRef.current = []
    const text = parts.join(' ').trim()
    if (text !== '') await appendTranscript(text)
  }

  // End the capture and write the captured text to the composer prompt. The
  // capturingRef is flipped here (not on the next render) so a content utterance
  // arriving immediately is not mistaken for idle speech. There is no pause
  // inference: the capture stays open until the user explicitly says "stop" or
  // "send".
  const finalizeCapture = async (): Promise<void> => {
    capturingRef.current = false
    setCapturing(false)
    await flushCapture()
  }

  const submitDraft = (): void => {
    inputActions.submit()
  }

  // Classify one transcribed utterance against the configured commands.
  const handleUtterance = (text: string): void => {
    const current = settingsRef.current
    // Always include the default phrases alongside the user-configured ones, so
    // a stale (e.g. English) saved config cannot break the Portuguese commands.
    const config: CommandConfig = {
      listen: `${current.listenCommand}, ${DEFAULT_LISTEN_COMMAND}`,
      stop: `${current.stopCommand}, ${DEFAULT_STOP_COMMAND}`,
      send: `${current.sendCommand}, ${DEFAULT_SEND_COMMAND}`,
    }
    const { kind, payload } = classify(text, config)
    // Always show what the loop heard while hands-free is on — the "heard"
    // balloon is the diagnostic that tells us whether Whisper is recognizing
    // the command phrase or producing something else.
    heardSeq.current += 1
    setHeard({ seq: heardSeq.current, text, kind })
    if (kind === 'listen') {
      // Only reset the capture buffer on a FRESH capture; a redundant or
      // misheard "iniciar" during an active capture must not wipe what has
      // already been recorded.
      if (!capturingRef.current) capturedRef.current = []
      capturingRef.current = true
      setCapturing(true)
      if (payload !== '') capturedRef.current.push(payload)
    } else if (kind === 'send') {
      if (capturingRef.current && payload !== '') capturedRef.current.push(payload)
      void finalizeCapture()
      submitDraft()
    } else if (kind === 'stop') {
      if (capturingRef.current) {
        if (payload !== '') capturedRef.current.push(payload)
        void finalizeCapture()
      }
    } else if (capturingRef.current) {
      if (payload !== '') capturedRef.current.push(payload)
    }
  }

  const stopHandsFree = async (): Promise<void> => {
    const handle = handsFreeRef.current
    handsFreeRef.current = null
    capturingRef.current = false
    setCapturing(false)
    if (handle !== null) await handle.dispose()
  }

  const startHandsFree = async (): Promise<void> => {
    if (handsFreeRef.current !== null) return
    try {
      handsFreeRef.current = await beginHandsFree(
        handleUtterance,
        getEndpoint,
        () => settingsRef.current.language,
        (lv) => { if (capturingRef.current) setLevels(lv) },
        (on) => { handleProcessing(on ? 1 : -1) },
      )
    } catch (_micFailure) {
      showError(t('error.mic'))
      setSettings({ handsFree: false })
    }
  }

  // Drive the loop from the (reactive) hands-free flag.
  useEffect(() => {
    if (settings.handsFree) void startHandsFree()
    else void stopHandsFree()
  }, [settings.handsFree])

  // Release the mic and any capture session on unmount.
  useEffect(() => () => {
    recorderRef.current?.cancel()
    void handsFreeRef.current?.dispose()
  }, [])

  // Validate the local Whisper server while hands-free is on: probe /health and
  // warn (and show the "offline" indicator) when it drops.
  useEffect(() => {
    if (!settings.handsFree) return
    let cancelled = false
    const check = async (): Promise<void> => {
      const ok = await checkWhisperHealth(settingsRef.current.endpoint)
      if (cancelled) return
      setServerDown(!ok)
    }
    void check()
    const interval = window.setInterval(() => { void check() }, 12_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [settings.handsFree, settings.endpoint])

  // Auto-clear the "heard" feedback shortly after it appears.
  useEffect(() => {
    if (heard === null) return
    const timer = window.setTimeout(() => { setHeard(null) }, 3500)
    return () => { window.clearTimeout(timer) }
  }, [heard?.seq])

  const onButtonClick = (): void => {
    if (settings.handsFree) {
      // Hands-free stays active: the click toggles the current capture the same
      // way the "iniciar"/"parar" commands do (start accumulating speech, or
      // flush what was captured into the composer). It never leaves the mode.
      if (capturingRef.current) void finalizeCapture()
      else {
        capturedRef.current = []
        capturingRef.current = true
        setCapturing(true)
      }
      return
    }
    if (phase === 'recording') void stop()
    else if (phase === 'idle') void start()
  }

  const recording = phase === 'recording'
  const busy = phase === 'transcribing'
  const showWave = recording || capturing
  const showStop = recording || capturing
  const processingNow = busy || processing
  const listening = settings.handsFree && !capturing && !processingNow
  const primaryLabel = recording || capturing ? t('aria.stop') : t('aria.start')
  const overlayTitle = serverDown && settings.handsFree
    ? t('aria.serverDown')
    : processingNow
      ? t('aria.transcribing')
      : recording || capturing
        ? t('aria.capturing')
        : listening ? t('aria.listening') : primaryLabel
  const menuStyle: CSSProperties | undefined = menuPosition === null
    ? { visibility: 'hidden' }
    : { left: menuPosition.left, top: menuPosition.top }

  return (
    <div ref={rootRef} className={css.root}>
      {showWave && (
        <div className={css.wave} aria-hidden>
          {levels.map((level, index) => (
            <span
              key={index}
              className={css.bar}
              style={{ height: `${Math.max(3, Math.round(level * 24))}px` }}
            />
          ))}
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        className={clsx(
          css.button,
          showStop && css.buttonRecording,
          busy && css.buttonBusy,
          listening && css.listening,
          serverDown && settings.handsFree && css.serverDown,
        )}
        aria-label={primaryLabel}
        aria-pressed={recording || capturing}
        disabled={busy}
        title={overlayTitle}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={onButtonClick}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuOpen(true)
        }}
      >
        {processingNow
          ? <span className={css.spinner} aria-hidden />
          : showStop
            ? <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><rect x="4" y="4" width="8" height="8" rx="2" fill="currentColor" /></svg>
            : (
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden>
                <rect x="6" y="1.5" width="4" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M8 12v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M5 14.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            )}
      </button>

      {heard !== null && settings.handsFree && (
        <div key={heard.seq} className={css.heard} role="status">
          {heard.kind !== null && <strong className={css.heardKind}>{heard.kind.toUpperCase()}</strong>}
          <span className={css.heardText}>{heard.text}</span>
        </div>
      )}

      {menuOpen && (
        <div ref={menuRef} className={css.menu} style={menuStyle} role="menu">
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { setMenuOpen(false); setConfigOpen(true) }}
          >
            {t('menu.configs')}
          </button>
        </div>
      )}

      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          onDone={() => { setToast(null) }}
        />
      )}

      <ConfigModal
        open={configOpen}
        onClose={() => { setConfigOpen(false) }}
        initial={settings}
        onSave={(next) => { setSettings(next) }}
        getModels={getModels}
        sessionId={sessionId}
        t={t}
      />
    </div>
  )
}
