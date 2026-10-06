# Two-stage build: stage 1 resolves every Python dep (CPU-only torch), stage 2
# ships just the venv + runtime system deps. No model weights are baked in —
# models download on first use into the model-cache volume.

FROM python:3.12-slim AS builder

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install --no-cache-dir --upgrade pip

# CPU wheels first: PyPI torch ships CUDA-bundled wheels (~2.5 GB); containers
# have no GPU passthrough, so the CPU index keeps the image ~1 GB smaller.
# Installing it before requirements.txt means sentence-transformers finds it
# already satisfied and never re-resolves the PyPI (CUDA) wheel.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Audio extras normally installed by scripts/install_audio.sh (see the
# requirements.txt notes): Kokoro hard-pins numpy==1.26.4 and misaki pulls an
# unbuildable thinc, so both go in --no-deps. espeak-ng is apt'd in stage 2.
RUN pip install --no-cache-dir loguru spacy phonemizer num2words \
 && pip install --no-cache-dir --no-deps misaki==0.7.4 kokoro==0.7.16

# misaki downloads en_core_web_sm into site-packages at first TTS/podcast use;
# bake it in at build time so that moment stays offline (site-packages is not
# inside the model-cache volume).
RUN python -m spacy download en_core_web_sm


FROM python:3.12-slim

# tesseract: OCR fallback for scanned PDFs; espeak-ng: Kokoro phoneme fallback;
# libgomp1: faiss; libsndfile1: soundfile; curl: container HEALTHCHECK;
# git: /ingest/github; procps: ps for /system/memory.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr espeak-ng libgomp1 libsndfile1 curl git procps \
 && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/venv/bin:$PATH \
    DOCSEEK_DATA_DIR=/data \
    HF_HOME=/root/.cache/huggingface

WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY app/ ./app/

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD curl -sf http://localhost:8000/web-research/health || exit 1

CMD ["python", "-m", "app.server"]
