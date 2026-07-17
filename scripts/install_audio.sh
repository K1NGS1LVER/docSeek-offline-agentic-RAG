#!/usr/bin/env bash
#
# Install the local podcast / text-to-speech stack (Kokoro-82M).
#
# Why this isn't just a line in requirements.txt: Kokoro 0.7.16 hard-pins
# numpy==1.26.4, and its misaki[en] extra pulls spacy-curated-transformers
# (which forces an unbuildable thinc/blis on recent Python). Both fight
# docSeek's numpy-2.x stack. So we install Kokoro's real runtime deps ourselves
# (torch/transformers/scipy/huggingface-hub already come via
# sentence-transformers) and add Kokoro + misaki with --no-deps.
#
# Usage:  ./scripts/install_audio.sh          (uses ./.venv)
#         PYTHON=python3 ./scripts/install_audio.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
PY="${PYTHON:-.venv/bin/python}"

echo "==> Installing Kokoro TTS runtime deps (spaCy G2P + audio I/O)..."
"$PY" -m pip install soundfile loguru spacy phonemizer num2words

echo "==> Installing Kokoro + misaki without their conflicting declared deps..."
"$PY" -m pip install --no-deps misaki==0.7.4 kokoro==0.7.16

# espeak-ng is the grapheme-to-phoneme fallback for out-of-vocabulary words
# (drug names, acronyms, numbers, symbols). Without it, misaki cannot phonemize
# such tokens and those passages are skipped. Strongly recommended.
echo "==> Installing espeak-ng (phoneme fallback for unusual words)..."
if command -v brew >/dev/null 2>&1; then
    brew list espeak-ng >/dev/null 2>&1 || brew install espeak-ng
elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y espeak-ng
else
    echo "   (could not auto-install espeak-ng; install it via your package manager)"
fi

echo
echo "Done. The Kokoro-82M weights and a spaCy English model download once on"
echo "first podcast / TTS use, then run fully offline."
