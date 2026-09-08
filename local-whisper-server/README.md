# Local Whisper server

A small, self-contained **local speech-to-text** server for the DeepSeek Harness
voice-input plugin. It runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
— the OpenAI Whisper models re-implemented over CTranslate2 for fast CPU/GPU
inference — behind an HTTP endpoint compatible with the whisper.cpp `server`
contract the plugin already targets.

The server is intentionally kept **outside** the harness so the plugin can point
at any transcription provider (whisper.cpp, OpenAI's `whisper`, a cloud API, …).
This project is just the default local one.

## Endpoints

### `GET /health`

Reports liveness and the configured model **without loading it** (so a health
probe stays cheap), e.g.:

```json
{ "status": "ok", "model": "small", "device": "cpu", "compute_type": "int8" }
```

### `POST /inference`

Multipart form:

| field      | value                                                                  |
|------------|------------------------------------------------------------------------|
| `file`     | audio the server can decode (16-bit PCM mono WAV from the plugin, or any audio `ffmpeg` can read) |
| `language` | optional two-letter language, e.g. `pt`; omitted = auto-detect          |

Returns `{ "text": "...", "language": "pt" }`. The plugin POSTs the recorded WAV
as `file` and reads `text`.

### `POST /clean`

Best-effort **LLM cleanup** of a transcription (used to fix misrecognized words
and remove hesitations before the text reaches the prompt). Multipart form:

| field             | value                                                                    |
|-------------------|--------------------------------------------------------------------------|
| `text`            | the raw transcription                                                    |
| `context`         | optional recent-conversation context for consistency                     |
| `api_key`         | optional OpenAI-compatible API key (overrides `CLEANUP_API_KEY`)         |
| `model`           | optional cleanup model name (overrides `CLEANUP_MODEL`)                  |
| `reasoning_effort`| optional `off`/`low`/`high`/`max` (overrides `CLEANUP_REASONING_EFFORT`) |

Sends an OpenAI-compatible `POST {CLEANUP_BASE_URL}/v1/chat/completions` with
`temperature: 0.0`. Returns `{ "text": "...", "cleaned": true }`, or
`{ "text": <raw>, "cleaned": false }` when no API key is configured or the call
fails (cleanup is never allowed to fail the transcription).

## Setup

Requires Python 3.10–3.12 (3.12 recommended) and `ffmpeg` on `PATH`.

```sh
python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

The first transcription downloads the selected model from the Hugging Face hub
into `~/.cache/huggingface` and caches it there.

## Run

```sh
# from this directory, with the venv active
python server.py
# or:
WHISPER_MODEL=small WHISPER_LANGUAGE=pt WHISPER_PORT=9000 python server.py
```

The server listens on `127.0.0.1:9000` by default, matching the plugin's default
endpoint (`voice-input.endpoint`).

### Auto-start from the plugin (hands-free)

The plugin's host half validates `GET /health` and, when hands-free mode is on
and the server is down, **starts it automatically** through the harness
subprocess service using `venv/bin/python server.py` with `WHISPER_MODEL=small`,
`WHISPER_LANGUAGE=<configured>` and the host/port derived from your endpoint. So
you rarely need to start it by hand — but you can, and this README documents how.

## Configuration

| Env var                    | Default                                                          | Meaning |
|----------------------------|------------------------------------------------------------------|---------|
| `WHISPER_MODEL`            | `base`                                                           | `tiny`/`base`/`small`/`medium`/`large-v3` |
| `WHISPER_DEVICE`           | `cpu`                                                            | `cpu`, `cuda`, or `auto` |
| `WHISPER_COMPUTE_TYPE`     | `int8`                                                           | `int8` (CPU), `float16` (GPU) |
| `WHISPER_LANGUAGE`         | `en` (if unset → server forces `en`; unset the plugin default is `pt`) | force a 2-letter language; omit to auto-detect |
| `WHISPER_BEAM_SIZE`        | `5`                                                              | beam width |
| `WHISPER_HOST` / `WHISPER_PORT` | `127.0.0.1` / `9000`                                         | bind address |
| `WHISPER_CORS_ORIGINS`     | `http://127.0.0.1:3080,http://localhost:3080`                     | comma-separated allowed origins |
| `CLEANUP_BASE_URL`         | `https://api.deepseek.com`                                       | OpenAI-compatible base URL for `/clean` |
| `CLEANUP_MODEL`            | `deepseek-chat`                                                  | default cleanup model |
| `CLEANUP_API_KEY`          | unset                                                            | server-side cleanup API key (kept out of the browser) |
| `CLEANUP_REASONING_EFFORT` | `off`                                                            | cleanup reasoning effort; `""` omits the field |

## Smoke test

```sh
curl http://127.0.0.1:9000/health
curl -F "file=@recording.wav" http://127.0.0.1:9000/inference
curl -F "text=ola como vai" -F "reasoning_effort=off" http://127.0.0.1:9000/clean
```
