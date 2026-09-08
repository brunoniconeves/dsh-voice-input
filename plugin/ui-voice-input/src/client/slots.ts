/** Injected face of the composer voice button. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceSettings } from '../voice-settings.ts'

/** One available cleanup-model option. */
export interface CleanupModelOption {
  id: string
  label: string
}

/** Injected business face of the `conversation.input.right` voice entry. */
export interface VoiceInputInjected {
  /** Resolve the local Whisper endpoint at the moment of use (settings may load late). */
  getEndpoint: () => string
  /** Persist a voice-settings patch to the Host document. */
  setSettings: (patch: Partial<VoiceSettings>) => void
  /** Fetch the session's available models for the cleanup-model dropdown. */
  getModels: (sessionId: string) => Promise<readonly CleanupModelOption[]>
  /** Reactive, fully-defaulted settings source bound to `useVoiceSettings`. */
  hooks: { voiceSettings: ObservableSnapshot<VoiceSettings> }
}
