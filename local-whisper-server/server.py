"""Local Whisper transcription server (faster-whisper).

Serves the whisper.cpp-compatible ``/inference`` route the dsh voice-input
plugin talks to: POST a multipart ``file`` (audio) and receive ``{"text": "..."}``.

Configuration is via environment variables (see README.md):

- ``WHISPER_MODEL``        tiny/base/small/medium/large-v3/large-v3-turbo (default base)
- ``WHISPER_DEVICE``       cpu / cuda / auto (default auto: GPU when available)
- ``WHISPER_COMPUTE_TYPE`` int8 / float16 / float32 (default float16 on GPU, int8 on CPU)
- ``WHISPER_LANGUAGE``     2-letter language to force, or auto-detect when unset
- ``WHISPER_BEAM_SIZE``    beam width (default 5)
- ``WHISPER_HOST`` / ``WHISPER_PORT``  bind address (default 127.0.0.1:9000)
- ``WHISPER_CORS_ORIGINS`` comma-separated allowed origins (default the dsh web origin)
- ``CLEANUP_REASONING_EFFORT`` LLM cleanup reasoning effort (default "off"; "" omits it)
"""

import os
import sys
import sysconfig
import tempfile
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware


def _cuda_lib_dirs() -> list[str]:
    """CUDA runtime library dirs shipped by the pip `nvidia-*-cu12` packages.

    CTranslate2 loads cuBLAS/cuDNN with a bare `dlopen("libcublas.so.12")`, so a
    venv-installed CUDA runtime is invisible unless its lib dirs are on the
    loader path. Returning them lets us preload below without the caller having
    to export LD_LIBRARY_PATH.
    """
    dirs: list[str] = []
    for scheme in ("purelib", "platlib"):
        try:
            base = sysconfig.get_paths()[scheme]
        except Exception:
            continue
        for sub in ("nvidia/cublas/lib", "nvidia/cudnn/lib", "nvidia/cuda_nvrtc/lib", "nvidia/cuda_runtime/lib"):
            path = os.path.join(base, sub)
            if os.path.isdir(path):
                dirs.append(path)
    return list(dict.fromkeys(dirs))  # purelib and platlib often coincide


def _prepare_cuda_env() -> None:
    """Re-exec once with LD_LIBRARY_PATH pointing at the pip CUDA runtime libs.

    CTranslate2 dlopens `libcublas.so.12`/`libcudnn.so.8` by soname, so a
    venv-installed CUDA runtime must be on the loader path *at process start* —
    mutating LD_LIBRARY_PATH at runtime has no effect on subsequent dlopen.
    (Preloading the .so files with ctypes RTLD_GLOBAL instead is unreliable: it
    can hang on Pascal, e.g. via `libnvblas`.)

    The re-exec is guarded by an env flag so it can never loop.
    """
    dirs = _cuda_lib_dirs()
    if not dirs or os.environ.get("_WHISPER_CUDA_ENV") == "1":
        return
    current = os.environ.get("LD_LIBRARY_PATH", "")
    if all(directory in current.split(":") for directory in dirs):
        return
    os.environ["LD_LIBRARY_PATH"] = ":".join(dirs + ([current] if current else []))
    os.environ["_WHISPER_CUDA_ENV"] = "1"
    os.execv(sys.executable, [sys.executable, *sys.argv])


_prepare_cuda_env()

from faster_whisper import WhisperModel  # noqa: E402  (after CUDA loader-path setup)


def _cuda_usable() -> bool:
    """True only when a GPU is present AND the CUDA runtime libs can load.

    CTranslate2's wheel links CUDA dynamically: the device can be visible while
    inference still fails with "libcublas.so.12 is not found". Probe both the
    driver (device count) and the runtime libraries so `auto` never picks a
    GPU it cannot actually use.
    """
    import ctypes

    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() <= 0:
            return False
    except Exception:
        return False
    for lib in ("libcublas.so.12", "libcudnn.so.9", "libcudnn.so.8"):
        try:
            ctypes.CDLL(lib)
            return True
        except OSError:
            continue
    return False


def _supported_compute_types(device: str) -> list[str]:
    """Compute types CTranslate2 supports on this device, best-first.

    Asking the backend avoids *attempting* an unsupported type: on a Pascal GPU
    (GTX 10xx) a `float16` load does not fail cleanly — it can hang — so we must
    never try it there.
    """
    try:
        import ctranslate2

        supported = set(ctranslate2.get_supported_compute_types(device))
    except Exception:
        supported = set()
    preferred = ("float16", "int8_float32", "float32", "int8") if device == "cuda" \
        else ("int8", "int8_float32", "float32")
    ordered = [ct for ct in preferred if not supported or ct in supported]
    return ordered or (["float16"] if device == "cuda" else ["int8"])


MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
# Device: `auto` (default) uses the GPU only when it is genuinely usable,
# otherwise the CPU. `WHISPER_DEVICE=cpu`/`cuda` forces one explicitly.
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
if DEVICE == "auto":
    DEVICE = "cuda" if _cuda_usable() else "cpu"
# Compute type: the best the device actually supports, unless explicitly set.
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE") or _supported_compute_types(DEVICE)[0]
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
# The compute type the model actually loaded with (may differ from COMPUTE_TYPE
# after the GPU fallback chain); reported by /health once known.
_compute_in_use: str | None = None


def _load_model() -> WhisperModel:
    global _model, _compute_in_use
    if _model is None:
        # Try the configured type first, then every type the device supports
        # (best-first). Unsupported types are never attempted, so a Pascal GPU
        # cannot hang on a float16 load.
        candidates = list(dict.fromkeys([COMPUTE_TYPE, *_supported_compute_types(DEVICE)]))
        last_error: Exception | None = None
        for compute_type in candidates:
            try:
                _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=compute_type)
                _compute_in_use = compute_type
                return _model
            except Exception as exc:  # unsupported/unavailable compute type
                last_error = exc
        raise last_error if last_error is not None else RuntimeError("model load failed")
    return _model


@app.get("/health")
def health() -> dict:
    """Report liveness and the configured model without loading it."""
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": _compute_in_use or COMPUTE_TYPE,
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
