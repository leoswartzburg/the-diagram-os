# Faster-Whisper STT for NVIDIA Blackwell GPUs (RTX 50-series, sm_120).
# cudnn-runtime base supplies the cuDNN 9 + cuBLAS libs CTranslate2 links against.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir "faster-whisper>=1.1.1" fastapi uvicorn python-multipart

WORKDIR /app
COPY server.py .

EXPOSE 8005
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8005"]
