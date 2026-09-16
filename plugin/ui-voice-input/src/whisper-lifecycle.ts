/**
 * Host-side lifecycle for the local Whisper server. When the voice plugin is
 * running in hands-free mode, the node half guarantees the transcribe server is
 * actually reachable: it validates `/health` and, when the server is down,
 * starts it through `ctx.subprocess.spawn` (a managed child of the harness, so
 * the harness owns its lifetime). This keeps the voice infrastructure local to
 * the developer's machine while the plugin stays provider-agnostic — it only
 * ever talks to the endpoint the user configured.
 *
 * The server is a FastAPI + faster-whisper app (see ~/Projects/local-whisper-server),
 * launched with the model/language/bind the host needs. Every step degrades to a
 * logged no-op rather than a thrown error: this is a best-effort convenience on
 * top of the client-side health warning, never a harness dependency.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { VoiceSettings } from './voice-settings.ts'

/** Timeout for a single `/health` probe, in milliseconds. */
const HEALTH_TIMEOUT_MS = 3_000

/** How long to wait for the freshly-started server to come up, in milliseconds. */
const STARTUP_PATH_MS = 30_000

/** Interval between startup probes, in milliseconds. */
const STARTUP_PROBE_MS = 750

/** Bounded capture of the server's stdout/stderr for diagnosis. */
const OUTPUT_MAX_BYTES = 200_000

/**
 * The local Whisper server's source directory. The venv holds the `python`
 * executable and the `server.py` module; both live inside this directory.
 * Configurable through the voice-input settings (see {@link serverDirOf}).
 */
export const DEFAULT_WHISPER_SERVER_DIR = '/home/bruno/Projects/local-whisper-server'

/** Fallback faster-whisper model when the settings name none (canonical repo id). */
const FALLBACK_WHISPER_MODEL = 'dropbox-dash/faster-whisper-large-v3-turbo'

/**
 * Map the transcription endpoint to its `/health` route.
 * @param endpoint - the transcription endpoint (e.g. `http://127.0.0.1:9000/inference`).
 * @returns the same origin with the `/health` path.
 */
export function healthUrlOf(endpoint: string): string {
  return endpoint.replace(/\/inference\/?$/, '/health')
}

/** Resolve the endpoint's origin, falling back to the default local bind. */
function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin
  } catch {
    return 'http://127.0.0.1:9000'
  }
}

/**
 * Probe the server's `/health` route.
 * @param endpoint - the transcription endpoint (e.g. `http://127.0.0.1:9000/inference`).
 * @returns true when the server answers within the timeout with an OK status.
 */
export async function isWhisperUp(endpoint: string): Promise<boolean> {
  const url = healthUrlOf(endpoint)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The directory the server source lives in. Prefer the user-configured value,
 * then the known default.
 * @param settings - the resolved voice settings.
 * @returns a non-empty server directory path.
 */
export function serverDirOf(settings: VoiceSettings): string {
  return settings.serverDir.trim() || DEFAULT_WHISPER_SERVER_DIR
}

/** The managed child already started, so we never spawn twice for one endpoint. */
const liveHandleByOrigin = new Map<string, SubprocessHandle>()

/** Whether a startup sweep is already running, so concurrent calls coalesce. */
const sweepByOrigin = new Map<string, Promise<boolean>>()

/** The subprocess spawn capability when the harness mounted it, else undefined. */
function subprocessOf(ctx: Context): ((spec: SubprocessSpawnSpec) => SubprocessHandle) | undefined {
  try {
    const value = (ctx as unknown as { subprocess?: { spawn?: (spec: SubprocessSpawnSpec) => SubprocessHandle } }).subprocess
    return value?.spawn
  } catch {
    return undefined
  }
}

/** Build the server's argv (venv python + server.py), cwd, and environment. */
function launchSpec(
  ctx: Context,
  settings: VoiceSettings,
): { argv: readonly string[]; cwd: string; env: Record<string, string> } | null {
  if (subprocessOf(ctx) === undefined) {
    ctx.logger.warn('voice-input: subprocess service unavailable; cannot auto-start the Whisper server')
    return null
  }
  const cwd = serverDirOf(settings)
  const python = `${cwd}/venv/bin/python`
  try {
    const url = new URL(originOf(settings.endpoint))
    return {
      argv: [python, 'server.py'],
      cwd,
      env: {
        WHISPER_MODEL: settings.serverModel.trim() || FALLBACK_WHISPER_MODEL,
        WHISPER_LANGUAGE: settings.language || 'pt',
        WHISPER_HOST: url.hostname,
        WHISPER_PORT: url.port || '9000',
      },
    }
  } catch {
    return null
  }
}

/**
 * Validate the Whisper server and, when it is down and hands-free is active,
 * start it through the harness subprocess service. Coalesces concurrent calls
 * per endpoint and never spawns a second process for one that is already up.
 * @param ctx - the harness context (subprocess service and logging).
 * @param settings - the resolved voice settings (endpoint, language, serverDir).
 * @returns true once the server reports healthy (already up or just started),
 * false when it could not be started or did not come up in time.
 */
export async function ensureWhisperServer(ctx: Context, settings: VoiceSettings): Promise<boolean> {
  const endpoint = settings.endpoint
  const origin = originOf(endpoint)
  if (await isWhisperUp(endpoint)) return true

  const inFlight = sweepByOrigin.get(origin)
  if (inFlight !== undefined) return inFlight

  const sweep = startServerSweep(ctx, origin, endpoint, settings).finally(() => {
    sweepByOrigin.delete(origin)
  })
  sweepByOrigin.set(origin, sweep)
  return sweep
}

/** Start the server (if it is down) and poll until it reports healthy. */
async function startServerSweep(
  ctx: Context,
  origin: string,
  endpoint: string,
  settings: VoiceSettings,
): Promise<boolean> {
  const spec = launchSpec(ctx, settings)
  if (spec === null) return false
  // A server is already starting for this endpoint; just wait for it.
  const existing = liveHandleByOrigin.get(origin)
  if (existing !== undefined) {
    return await untilUp(endpoint)
  }
  let handle: SubprocessHandle
  try {
    const spawn = subprocessOf(ctx)
    if (spawn === undefined) return false
    handle = spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: OUTPUT_MAX_BYTES },
        stderr: { maxBytes: OUTPUT_MAX_BYTES },
      },
      graceMs: 5_000,
      env: spec.env,
    })
  } catch (error) {
    ctx.logger.warn('voice-input: failed to start the Whisper server', error)
    return false
  }
  liveHandleByOrigin.set(origin, handle)
  ctx.logger.info('voice-input: started the local Whisper server')
  // A server that died before going healthy should not keep dying silently.
  void handle.done.then(() => {
    if (liveHandleByOrigin.get(origin) === handle) liveHandleByOrigin.delete(origin)
  })
  return await untilUp(endpoint)
}

/** Poll `/health` until it answers, within {@link STARTUP_PATH_MS}. */
async function untilUp(endpoint: string): Promise<boolean> {
  const deadline = Date.now() + STARTUP_PATH_MS
  while (Date.now() < deadline) {
    if (await isWhisperUp(endpoint)) return true
    await new Promise(resolve => setTimeout(resolve, STARTUP_PROBE_MS))
  }
  return false
}
