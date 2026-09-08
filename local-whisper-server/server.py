"""Local Whisper transcription server (faster-whisper).

Serves the whisper.cpp-compatible ``/inference`` route the dsh voice-input
plugin talks to: POST a multipart ``file`` (audio) and receive ``{"text": "..."}``.

Configuration is via environment variables (see README.md):

- ``WHISPER_MODEL``        model size: tiny/base/small/medium/large-v3 (default base)
- ``WHISPER_DEVICE``       cpu / cuda / auto (default cpu)
- ``WHISPER_COMPUTE_TYPE`` int8 / float16 / float32 (default int8)
- ``WHISPER_LANGUAGE``     2-letter language to force, or auto-detect when unset
- ``WHISPER_BEAM_SIZE``    beam width (default 5)
- ``WHISPER_HOST`` / ``WHISPER_PORT``  bind address (default 127.0.0.1:9000)
- ``WHISPER_CORS_ORIGINS`` comma-separated allowed origins (default the dsh web origin)
- ``CLEANUP_REASONING_EFFORT`` LLM cleanup reasoning effort (default "off"; "" omits it)
"""

import os
import tempfile
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or "en"
HOST = os.environ.get("WHISPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHISPER_PORT", "9000"))

# Optional LLM cleanup (OpenAI-compatible chat completions). Key is read
# server-side so it never reaches the browser; it can be DeepSeek, Ollama, etc.
CLEANUP_BASE_URL = os.environ.get("CLEANUP_BASE_URL", "https://api.deepseek.com")
CLEANUP_MODEL = os.environ.get("CLEANUP_MODEL", "deepseek-chat")
CLEANUP_API_KEY = os.environ.get("CLEANUP_API_KEY", "")
# Lowest reasoning effort so the cleanup is as fast as possible. "off" disables
# thinking entirely (fastest for a simple cleanup); a reasoning model may also
# accept "low". Empty string omits the field and lets the provider pick.
CLEANUP_REASONING_EFFORT = os.environ.get("CLEANUP_REASONING_EFFORT", "off")

CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "WHISPER_CORS_ORIGINS",
        "http://127.0.0.1:3080,http://localhost:3080",
    ).split(",")
    if origin.strip()
]

app = FastAPI(title="local-whisper", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Loaded lazily on first transcription so /health stays cheap and a bad model
# name fails only when it is actually used.
_model: WhisperModel | None = None


def _load_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    return _model


@app.get("/health")
def health() -> dict:
    """Report liveness and the configured model without loading it."""
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


@app.post("/inference")
async def inference(
    file: Annotated[UploadFile, File()],
    language: Annotated[str | None, Form()] = None,
) -> dict:
    """Transcribe one uploaded audio file and return its text."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="missing file name")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty audio upload")

    suffix = os.path.splitext(file.filename)[1] or ".wav"
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        segments, info = _load_model().transcribe(
            path,
            language=language or LANGUAGE,
            beam_size=BEAM_SIZE,
            condition_on_previous_text=False,
            # Trim leading/trailing silence and non-speech so a quiet mic cannot
            # make the model hallucinate filler text.
            vad_filter=True,
        )
        text = "".join(segment.text for segment in segments).strip()
        return {"text": text, "language": info.language}
    except HTTPException:
        raise
    except Exception as exc:  # model load / decode / transcription failure
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        os.unlink(path)


def _clean_with_llm(text: str, context: str, api_key: str = "", model: str = "", reasoning_effort: str = "") -> str:
    """Ask the configured OpenAI-compatible model to clean a transcription."""
    import httpx

    api_key = api_key or CLEANUP_API_KEY
    model = model or CLEANUP_MODEL
    effort = reasoning_effort or CLEANUP_REASONING_EFFORT
    system = (
        "You clean speech-to-text transcriptions. Fix misrecognized words, remove "
        "hesitations and procedural noise, and keep the intended meaning. Use the "
        "conversation context when given to stay consistent. Respond ONLY with the "
        "cleaned text, no commentary."
    )
    user = f"Conversation context (may be empty):\n{context or '(none)'}\n\nTranscription:\n{text}"
    try:
        response = httpx.post(
            f"{CLEANUP_BASE_URL.rstrip('/')}/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.0,
                **(
                    {"reasoning_effort": effort}
                    if effort
                    else {}
                ),
            },
            timeout=60,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return content.strip()
    except Exception as exc:
        # Cleanup is best-effort: never fail the request over it, fall back to raw.
        return text


@app.post("/clean")
def clean(
    text: Annotated[str, Form()],
    context: Annotated[str, Form()] = "",
    api_key: Annotated[str, Form()] = "",
    model: Annotated[str, Form()] = "",
    reasoning_effort: Annotated[str, Form()] = "",
) -> dict:
    """Clean a transcription with the configured LLM using optional conversation context."""
    key = api_key or CLEANUP_API_KEY
    if key == "":
        return {"text": text, "cleaned": False}
    return {"text": _clean_with_llm(text, context, key, model, reasoning_effort), "cleaned": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
