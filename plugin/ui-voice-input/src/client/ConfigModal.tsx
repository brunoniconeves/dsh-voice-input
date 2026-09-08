/**
 * ConfigModal: the voice-input settings dialog opened from the button's
 * right-click menu. Edits the Whisper endpoint, the three hands-free command
 * phrases, and the hands-free on/off toggle, then persists the whole section
 * through the injected settings writer. Copy rides the standard locale seat.
 */
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceSettings } from '../voice-settings.ts'
import type { CleanupModelOption } from './slots.ts'
import css from './ConfigModal.module.css'

/** Full modal props: open/close control, the initial section, and the save callback. */
export interface ConfigModalProps {
  open: boolean
  onClose: () => void
  initial: VoiceSettings
  onSave: (next: Partial<VoiceSettings>) => void
  getModels: (sessionId: string) => Promise<readonly CleanupModelOption[]>
  sessionId: string
  t: TranslateNS<'voice'>
}

/**
 * Render the settings dialog.
 * @param props - control flags, the section to edit, and the save sink.
 * @returns the modal, or null when closed.
 */
export function ConfigModal({ open, onClose, initial, onSave, getModels, sessionId, t }: ConfigModalProps) {
  const [endpoint, setEndpoint] = useState(initial.endpoint)
  const [listen, setListen] = useState(initial.listenCommand)
  const [stop, setStop] = useState(initial.stopCommand)
  const [send, setSend] = useState(initial.sendCommand)
  const [handsFree, setHandsFree] = useState(initial.handsFree)
  const [language, setLanguage] = useState(initial.language)
  const [cleanup, setCleanup] = useState(initial.cleanup)
  const [cleanupApiKey, setCleanupApiKey] = useState(initial.cleanupApiKey)
  const [cleanupModel, setCleanupModel] = useState(initial.cleanupModel)
  const [cleanupEffort, setCleanupEffort] = useState(initial.cleanupEffort)
  const [serverDir, setServerDir] = useState(initial.serverDir)
  const [modelOptions, setModelOptions] = useState<readonly CleanupModelOption[]>([])

  /** Reasoning effort choices for the cleanup LLM; `off` is the fastest. */
  const EFFORT_OPTIONS: readonly { id: string; label: string }[] = [
    { id: 'off', label: t('effort.off') },
    { id: 'low', label: t('effort.low') },
    { id: 'high', label: t('effort.high') },
    { id: 'max', label: t('effort.max') },
  ]

  // Re-seed the form each time the dialog opens so a late settings sync is not lost.
  useEffect(() => {
    if (!open) return
    setEndpoint(initial.endpoint)
    setListen(initial.listenCommand)
    setStop(initial.stopCommand)
    setSend(initial.sendCommand)
    setHandsFree(initial.handsFree)
    setLanguage(initial.language)
    setCleanup(initial.cleanup)
    setCleanupApiKey(initial.cleanupApiKey)
    setCleanupModel(initial.cleanupModel)
    setCleanupEffort(initial.cleanupEffort)
    setServerDir(initial.serverDir)
  }, [open, initial])

  // Load the available models for the cleanup-model dropdown when cleanup is on.
  useEffect(() => {
    if (!open || !cleanup) return
    let cancelled = false
    void getModels(sessionId).then((options) => {
      if (!cancelled && options.length > 0) setModelOptions(options)
    })
    return () => { cancelled = true }
  }, [open, cleanup, getModels, sessionId])

  const dirty = endpoint.trim() === '' || listen.trim() === '' || stop.trim() === '' || send.trim() === ''
    || language.trim() === '' || (cleanup && cleanupApiKey.trim() === '') || (cleanup && cleanupModel.trim() === '')

  const save = (): void => {
    if (dirty) return
    onSave({
      endpoint: endpoint.trim(),
      listenCommand: listen.trim(),
      stopCommand: stop.trim(),
      sendCommand: send.trim(),
      handsFree,
      language: language.trim(),
      cleanup,
      cleanupApiKey: cleanupApiKey.trim(),
      cleanupModel: cleanup ? cleanupModel.trim() : '',
      cleanupEffort: cleanup ? cleanupEffort.trim() : '',
      serverDir: serverDir.trim(),
    })
    onClose()
  }

  // Persist whenever the modal closes (X, mask, Escape, Cancel) so edits are
  // never lost — then just close. The "Save" button is the same path.
  const closeAndSave = (): void => {
    if (!dirty) onSave({
      endpoint: endpoint.trim(),
      listenCommand: listen.trim(),
      stopCommand: stop.trim(),
      sendCommand: send.trim(),
      handsFree,
      language: language.trim(),
      cleanup,
      cleanupApiKey: cleanupApiKey.trim(),
      cleanupModel: cleanup ? cleanupModel.trim() : '',
      cleanupEffort: cleanup ? cleanupEffort.trim() : '',
      serverDir: serverDir.trim(),
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={closeAndSave}
      title={t('config.title')}
      closeLabel={t('config.close')}
      footer={(
        <div className={css.actions}>
          <Button variant="outline" onClick={closeAndSave}>{t('config.cancel')}</Button>
          <Button variant="primary" disabled={dirty} onClick={save}>{t('config.save')}</Button>
        </div>
      )}
    >
      <div className={css.form}>
        <label className={css.field}>
          <span className={css.label}>{t('config.endpoint')}</span>
          <input
            className={css.input}
            type="url"
            value={endpoint}
            onChange={(event) => { setEndpoint(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('config.listen')}</span>
          <input
            className={css.input}
            type="text"
            value={listen}
            onChange={(event) => { setListen(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('config.stop')}</span>
          <input
            className={css.input}
            type="text"
            value={stop}
            onChange={(event) => { setStop(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('config.send')}</span>
          <input
            className={css.input}
            type="text"
            value={send}
            onChange={(event) => { setSend(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('config.language')}</span>
          <input
            className={css.input}
            type="text"
            value={language}
            maxLength={2}
            placeholder="en"
            onChange={(event) => { setLanguage(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('config.serverDir')}</span>
          <input
            className={css.input}
            type="text"
            value={serverDir}
            onChange={(event) => { setServerDir(event.target.value) }}
          />
        </label>
        <label className={css.switch}>
          <input
            className={css.checkbox}
            type="checkbox"
            checked={handsFree}
            onChange={(event) => { setHandsFree(event.target.checked) }}
          />
          <span className={css.switchCopy}>
            <span className={css.labelStrong}>{t('config.handsFree')}</span>
            <span className={css.hint}>{t('config.handsFreeHint')}</span>
          </span>
        </label>
        <label className={css.switch}>
          <input
            className={css.checkbox}
            type="checkbox"
            checked={cleanup}
            onChange={(event) => { setCleanup(event.target.checked) }}
          />
          <span className={css.switchCopy}>
            <span className={css.labelStrong}>{t('config.cleanup')}</span>
            <span className={css.hint}>{t('config.cleanupHint')}</span>
          </span>
        </label>
        {cleanup && (
          <>
            <label className={css.field}>
              <span className={css.label}>{t('config.cleanupModel')}</span>
              <select
                className={css.input}
                value={cleanupModel}
                onChange={(event) => { setCleanupModel(event.target.value) }}
              >
                {modelOptions.length === 0 && <option value="deepseek-chat">deepseek-chat</option>}
                {modelOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
                {cleanupModel.trim() !== '' && !modelOptions.some(option => option.id === cleanupModel)
                  && <option value={cleanupModel}>{cleanupModel}</option>}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('config.cleanupEffort')}</span>
              <select
                className={css.input}
                value={cleanupEffort}
                onChange={(event) => { setCleanupEffort(event.target.value) }}
              >
                {EFFORT_OPTIONS.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('config.cleanupApiKey')}</span>
              <input
                className={css.input}
                type="password"
                value={cleanupApiKey}
                placeholder="sk-..."
                onChange={(event) => { setCleanupApiKey(event.target.value) }}
              />
            </label>
          </>
        )}
      </div>
    </Modal>
  )
}
