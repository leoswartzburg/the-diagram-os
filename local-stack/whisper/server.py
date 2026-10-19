"""Local STT — Faster-Whisper large-v3-turbo on GPU, OpenAI-compatible endpoint.

Mirrors Groq's /openai/v1/audio/transcriptions shape so /api/stt can hit either
interchangeably. Blackwell (sm_120) note: CTranslate2 INT8 kernels crash with
CUBLAS_STATUS_NOT_SUPPORTED on RTX 50-series — compute_type MUST be float16.
"""
import io
import logging
import os
import time

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO, format="[whisper] %(message)s")
log = logging.getLogger(__name__)

MODEL_ID = os.environ.get("WHISPER_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
# float16: the only compute type that works on Blackwell (sm_120) — do not change to int8.
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")

app = FastAPI()
model: WhisperModel | None = None


@app.on_event("startup")
def load_model() -> None:
    global model
    t0 = time.time()
    log.info(f"loading {MODEL_ID} ({DEVICE}/{COMPUTE_TYPE}) …")
    model = WhisperModel(MODEL_ID, device=DEVICE, compute_type=COMPUTE_TYPE)
    log.info(f"model ready in {time.time() - t0:.1f}s")


@app.get("/health")
def health():
    return {"ok": model is not None, "model": MODEL_ID}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("en"),
    # Accepted for OpenAI-API compatibility; the loaded model is always used.
    model_name: str = Form("whisper-large-v3-turbo", alias="model"),
    response_format: str = Form("json"),
):
    if model is None:
        return JSONResponse({"error": "model not loaded"}, status_code=503)
    data = await file.read()
    if not data:
        return JSONResponse({"error": "empty audio"}, status_code=400)
    t0 = time.time()
    # beam_size=1 + no cross-segment conditioning: fastest decode for short
    # conversational utterances (quality parity with Groq's turbo endpoint).
    segments, info = model.transcribe(
        io.BytesIO(data),
        language=language or "en",
        beam_size=1,
        condition_on_previous_text=False,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    log.info(f"transcribed {len(data)/1024:.0f}KB ({info.duration:.1f}s audio) in {time.time() - t0:.2f}s")
    return {"text": text}
