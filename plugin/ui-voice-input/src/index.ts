/** Host registration for the browser voice-input endpoint preference. */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  VOICE_SETTINGS_NAMESPACE, VoiceSettingsSchema, type VoiceSettings,
} from './voice-settings.ts'
import { ensureWhisperServer } from './whisper-lifecycle.ts'

export {
  DEFAULT_CLEANUP, DEFAULT_CLEANUP_API_KEY, DEFAULT_CLEANUP_EFFORT, DEFAULT_CLEANUP_MODEL,
  DEFAULT_ENDPOINT, DEFAULT_HANDS_FREE, DEFAULT_LANGUAGE, DEFAULT_LISTEN_COMMAND,
  DEFAULT_SEND_COMMAND, DEFAULT_STOP_COMMAND, DEFAULT_SERVER_DIR,
  VOICE_CLEANUP_API_KEY_FIELD, VOICE_CLEANUP_EFFORT_FIELD, VOICE_CLEANUP_FIELD, VOICE_CLEANUP_MODEL_FIELD,
  VOICE_ENDPOINT_FIELD, VOICE_HANDS_FREE_FIELD, VOICE_LANGUAGE_FIELD, VOICE_LISTEN_FIELD,
  VOICE_SEND_FIELD, VOICE_SERVER_DIR_FIELD, VOICE_SETTINGS_NAMESPACE, VOICE_STOP_FIELD, type VoiceSettings,
} from './voice-settings.ts'

/** Keep a reference to the in-flight auto-start so we do not spawn twice. */
let autoStartTask: Promise<boolean> | undefined

/**
 * Register the durable voice-input section when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      settingsNamespace(VOICE_SETTINGS_NAMESPACE),
      VoiceSettingsSchema,
    )
    startHandsFreeLifecycle(ctx, scope)
  })
}

/**
 * When hands-free mode becomes active (or is already active at startup), make
 * sure the local Whisper server is reachable, starting it through the harness
 * subprocess service if it is not.
 * @param ctx - the host context (for the subprocess service and logging).
 * @param scope - the registered voice-input settings scope.
 */
function startHandsFreeLifecycle(ctx: Context, scope: SettingsScope<VoiceSettings>): void {
  const ensure = (settings: VoiceSettings): void => {
    if (!settings.handsFree) return
    if (autoStartTask !== undefined) return
    autoStartTask = ensureWhisperServer(ctx, settings)
      .then((up) => {
        if (!up) ctx.logger.warn('voice-input: Whisper server did not come up automatically')
        return up
      })
      .finally(() => {
        autoStartTask = undefined
      })
  }

  // Cover the case where hands-free was already on when the plugin loaded.
  const initial = scope.get()
  if (initial.handsFree) ensure(initial)

  // React when the user flips hands-free back on in the config modal.
  scope.watch((next, prev) => {
    if (next.handsFree && !prev.handsFree) ensure(next)
  })
}
