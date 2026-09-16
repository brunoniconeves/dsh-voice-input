/**
 * Voice input plugin, browser half: a microphone button registered into the
 * composer's `conversation.input.right` seat (just left of the send button).
 * Recording, the live waveform, the hands-free command loop, and the
 * local-Whisper transcription all live in the button; the endpoint, command
 * phrases, and the hands-free toggle arrive through the settings scope as a
 * reactive source, and recognized text is appended to the draft via the
 * standard `inputActions`. Export discipline: packages/client/AGENTS.md — only
 * the plugin body and the injected-face type leave the entrypoint.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.modelDirectories Context merge (cleanup-model dropdown).
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import {
  DEFAULT_CLEANUP, DEFAULT_CLEANUP_API_KEY, DEFAULT_CLEANUP_EFFORT, DEFAULT_CLEANUP_MODEL,
  DEFAULT_ENDPOINT, DEFAULT_HANDS_FREE, DEFAULT_LANGUAGE, DEFAULT_LISTEN_COMMAND,
  DEFAULT_SEND_COMMAND, DEFAULT_SERVER_DIR, DEFAULT_SERVER_MODEL, DEFAULT_STOP_COMMAND,
  VOICE_SETTINGS_NAMESPACE, type VoiceSettings,
} from '../voice-settings.ts'
import { VoiceInputButton } from './VoiceInputButton.tsx'
import { en, zh, type VoiceKey } from './locales.ts'
import type { VoiceInputInjected, CleanupModelOption } from './slots.ts'

export type { VoiceInputInjected } from './slots.ts'
export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The voice input control's copy. */
    voice: VoiceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voice'

/** Required services: the slot registry, the copy, the settings scope, and the model directory. */
export const inject = ['slots', 'locale', 'modelDirectories', 'settingsScope']

/** Narrow a settings section to a fully-defaulted VoiceSettings. */
function deriveSettings(value: VoiceSettings | undefined): VoiceSettings {
  return {
    endpoint: (value?.endpoint ?? '').trim() || DEFAULT_ENDPOINT,
    listenCommand: (value?.listenCommand ?? '').trim() || DEFAULT_LISTEN_COMMAND,
    stopCommand: (value?.stopCommand ?? '').trim() || DEFAULT_STOP_COMMAND,
    sendCommand: (value?.sendCommand ?? '').trim() || DEFAULT_SEND_COMMAND,
    handsFree: value?.handsFree ?? DEFAULT_HANDS_FREE,
    language: (value?.language ?? '').trim() || DEFAULT_LANGUAGE,
    cleanup: value?.cleanup ?? DEFAULT_CLEANUP,
    cleanupApiKey: (value?.cleanupApiKey ?? '').trim() || DEFAULT_CLEANUP_API_KEY,
    cleanupModel: (value?.cleanupModel ?? '').trim() || DEFAULT_CLEANUP_MODEL,
    cleanupEffort: (value?.cleanupEffort ?? '').trim() || DEFAULT_CLEANUP_EFFORT,
    serverDir: (value?.serverDir ?? '').trim() || DEFAULT_SERVER_DIR,
    serverModel: (value?.serverModel ?? '').trim() || DEFAULT_SERVER_MODEL,
  }
}

/**
 * Adapt the settings into a referentially-stable ObservableSnapshot backed by
 * localStorage (durable across process/browser restarts even when the harness
 * settings scope is memory-mode for non-loopback access). The harness settings
 * scope is used for the initial value and best-effort host sync; localStorage is
 * the source of truth so the config (esp. the API key) always survives restarts.
 */
function createVoiceSettingsSource(scope: SettingsScope<VoiceSettings>): {
  observable: ObservableSnapshot<VoiceSettings>
  set: (patch: Partial<VoiceSettings>) => void
  getEndpoint: () => string
} {
  const STORAGE_KEY = 'dsh.voice-input.settings'
  const loadLocal = (): VoiceSettings | undefined => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw === null ? undefined : JSON.parse(raw) as VoiceSettings
    } catch (_parseFailure) {
      return undefined
    }
  }
  const saveLocal = (settings: VoiceSettings): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch (_storageFailure) {
      /* storage may be unavailable; session-only */
    }
  }
  let current = deriveSettings(loadLocal() ?? scope.getSnapshot().value)
  const listeners = new Set<() => void>()
  const publish = (): void => {
    current = deriveSettings(loadLocal() ?? scope.getSnapshot().value)
    for (const listener of listeners) listener()
  }
  // Mirror host settings changes (best-effort) so a foreign write is not lost.
  scope.subscribe(publish)
  return {
    observable: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set: (patch) => {
      saveLocal({ ...current, ...patch })
      for (const [field, value] of Object.entries(patch)) void scope.set(field, value)
      publish()
    },
    getEndpoint: () => current.endpoint,
  }
}

/**
 * Client plugin body: register the `voice` dictionaries and the mic button
 * into the composer's right tool-row seat. Settings are surfaced as a reactive
 * source so the hands-free loop starts/stops as the toggle changes.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-input: dictionaries')

  const scope = ctx.settingsScope.bind<VoiceSettings>({ namespace: VOICE_SETTINGS_NAMESPACE })
  const source = createVoiceSettingsSource(scope)
  const voiceSettings = source.observable
  const setSettings = (patch: Partial<VoiceSettings>): void => { source.set(patch) }
  const getEndpoint = (): string => source.getEndpoint()
  const getModels = async (sessionId: string): Promise<readonly CleanupModelOption[]> => {
    try {
      const directory = ctx.modelDirectories.directoryFor(sessionId as SessionId)
      await directory.load()
      return directory.store.getSnapshot().groups.flatMap(group =>
        group.models.map(model => ({ id: model.id, label: `${group.name} · ${model.name}` })),
      )
    } catch (_modelsFailure) {
      return []
    }
  }

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    {
      name: 'conversation.input.right',
      id: 'voice-input',
      locale: NS,
      inject: (): VoiceInputInjected => ({
        getEndpoint,
        setSettings,
        getModels,
        hooks: { voiceSettings },
      }),
    },
    VoiceInputButton,
  ))
}
