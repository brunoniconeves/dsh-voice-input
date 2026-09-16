/** Local-Whisper endpoint and hands-free command settings stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the voice-input plugin. */
export const VOICE_SETTINGS_NAMESPACE = 'voice-input'

/** Field carrying the local Whisper HTTP transcription endpoint. */
export const VOICE_ENDPOINT_FIELD = 'endpoint'

/** Field carrying the hands-free activation (start transcribing) command. */
export const VOICE_LISTEN_FIELD = 'listenCommand'

/** Field carrying the hands-free pause/stop command. */
export const VOICE_STOP_FIELD = 'stopCommand'

/** Field carrying the hands-free send command. */
export const VOICE_SEND_FIELD = 'sendCommand'

/** Field carrying whether the microphone listens continuously for commands. */
export const VOICE_HANDS_FREE_FIELD = 'handsFree'

/** Field carrying the transcription language (two-letter ISO code; empty = auto-detect). */
export const VOICE_LANGUAGE_FIELD = 'language'

/** Field carrying whether the raw transcription is cleaned by the configured LLM. */
export const VOICE_CLEANUP_FIELD = 'cleanup'

/** Field carrying the OpenAI-compatible API key used for LLM cleanup (sent per request). */
export const VOICE_CLEANUP_API_KEY_FIELD = 'cleanupApiKey'

/** Field carrying the model used for LLM cleanup (e.g. deepseek-chat, llama3). */
export const VOICE_CLEANUP_MODEL_FIELD = 'cleanupModel'

/** Field carrying the LLM cleanup reasoning effort (off/low/high/max). */
export const VOICE_CLEANUP_EFFORT_FIELD = 'cleanupEffort'

/** Default endpoint: the whisper.cpp `server` binary's `/inference` route. */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:9000/inference'

/** Default transcription language. Brazilian Portuguese so local pronunciation is recognized. */
export const DEFAULT_LANGUAGE = 'pt'

/** LLM cleanup is opt-in and needs the local server's CLEANUP_API_KEY to be set. */
export const DEFAULT_CLEANUP = false

/** No API key by default; it is provided per request when cleanup is enabled. */
export const DEFAULT_CLEANUP_API_KEY = ''

/** Default cleanup model (DeepSeek chat). */
export const DEFAULT_CLEANUP_MODEL = 'deepseek-chat'

/** Default LLM cleanup reasoning effort; `off` is the fastest (no thinking). */
export const DEFAULT_CLEANUP_EFFORT = 'off'

/** Field carrying the local Whisper server's source directory (for host auto-start). */
export const VOICE_SERVER_DIR_FIELD = 'serverDir'

/** Field carrying the faster-whisper model the local server loads (host auto-start). */
export const VOICE_SERVER_MODEL_FIELD = 'serverModel'

/** Default directory holding the local Whisper server (venv + server.py). */
export const DEFAULT_SERVER_DIR = '/home/bruno/Projects/local-whisper-server'

/** Default faster-whisper model: large-v3-turbo — best quality/speed trade-off.
 * Uses the canonical repo id because the short `large-v3-turbo` alias in
 * faster-whisper still points at the renamed `mobiuslabsgmbh/...` repo. */
export const DEFAULT_SERVER_MODEL = 'dropbox-dash/faster-whisper-large-v3-turbo'

/** Default phrases (comma-separated) that start hands-free transcription. Only
 * multi-word, distinctive phrases are defaults: a bare word like "iniciar" can
 * appear inside a dictated sentence and would re-trigger a fresh capture. */
export const DEFAULT_LISTEN_COMMAND =
  'iniciar transcrição, iniciar gravação, iniciar a gravação, começar transcrição, começar gravação, começar a gravação, iniciar captura, iniciar a transcrição, começar a gravar'

/** Default phrases (comma-separated) that pause hands-free capture and write the draft. */
export const DEFAULT_STOP_COMMAND =
  'parar transcrição, parar gravação, parar a gravação, parar de gravar, encerrar a gravação, parar a transcrição, pausar a gravação'

/** Default phrases (comma-separated) that send the transcribed prompt. */
export const DEFAULT_SEND_COMMAND =
  'enviar o prompt, enviar o texto, enviar a mensagem, enviar para o modelo, enviar prompt, enviar mensagem, enviar a transcrição, submeter'

/** Hands-free is opt-in: the microphone stays on only after the user enables it. */
export const DEFAULT_HANDS_FREE = false

/** Durable voice-input section shared by the Host schema and the browser scope. */
export interface VoiceSettings {
  /** Local Whisper transcription endpoint accepting multipart `file` audio and answering `{ "text": "..." }`. */
  endpoint: string
  /** Voice command that starts capturing the prompt (case/punctuation-insensitive). */
  listenCommand: string
  /** Voice command that pauses capture and keeps the accumulated text as a draft. */
  stopCommand: string
  /** Voice command that sends the captured prompt. */
  sendCommand: string
  /** Whether the microphone listens continuously for the voice commands. */
  handsFree: boolean
  /** Two-letter ISO transcription language, or '' to let the server auto-detect. */
  language: string
  /** Whether the raw transcription is cleaned by the configured LLM before it reaches the prompt. */
  cleanup: boolean
  /** OpenAI-compatible API key for the cleanup LLM (sent with each /clean request). */
  cleanupApiKey: string
  /** Model used for the cleanup LLM (e.g. deepseek-chat). */
  cleanupModel: string
  /** LLM cleanup reasoning effort (off/low/high/max). */
  cleanupEffort: string
  /** Directory holding the local Whisper server source (host auto-start). */
  serverDir: string
  /** faster-whisper model the host auto-start loads (tiny/base/small/medium/large-v3/large-v3-turbo). */
  serverModel: string
}

/** Durable voice-input schema; also the wire envelope the browser scope validates against. */
export const VoiceSettingsSchema: z<VoiceSettings> = z.object({
  [VOICE_ENDPOINT_FIELD]: z.string().default(DEFAULT_ENDPOINT),
  [VOICE_LISTEN_FIELD]: z.string().default(DEFAULT_LISTEN_COMMAND),
  [VOICE_STOP_FIELD]: z.string().default(DEFAULT_STOP_COMMAND),
  [VOICE_SEND_FIELD]: z.string().default(DEFAULT_SEND_COMMAND),
  [VOICE_HANDS_FREE_FIELD]: z.boolean().default(DEFAULT_HANDS_FREE),
  [VOICE_LANGUAGE_FIELD]: z.string().default(DEFAULT_LANGUAGE),
  [VOICE_CLEANUP_FIELD]: z.boolean().default(DEFAULT_CLEANUP),
  [VOICE_CLEANUP_API_KEY_FIELD]: z.string().default(DEFAULT_CLEANUP_API_KEY),
  [VOICE_CLEANUP_MODEL_FIELD]: z.string().default(DEFAULT_CLEANUP_MODEL),
  [VOICE_CLEANUP_EFFORT_FIELD]: z.string().default(DEFAULT_CLEANUP_EFFORT),
  [VOICE_SERVER_DIR_FIELD]: z.string().default(DEFAULT_SERVER_DIR),
  [VOICE_SERVER_MODEL_FIELD]: z.string().default(DEFAULT_SERVER_MODEL),
})
