"""
End-to-end tests for the local media features: dictation (/transcribe),
podcast generation (/podcast), and deep research reports (/research).

Like the rest of the suite these assert structure, not model output, so they
pass whether or not the optional local models (faster-whisper, Kokoro) are
cached and whether or not Ollama is running.
"""

import io
import math
import struct
import time
import wave

import requests

# faster-whisper's first call may download the model; be patient.
TIMEOUT = (10, 300)


def upload(server, filename, content, *, notebook):
    files = {"file": (filename, content.encode())}
    return requests.post(
        f"{server}/upload", files=files, data={"notebook_id": notebook}, timeout=TIMEOUT
    )


def _poll_podcast(server, job_id, notebook, timeout=90):
    """Poll a podcast job until it reaches a terminal status."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = requests.get(
            f"{server}/podcast/status",
            params={"job_id": job_id, "notebook_id": notebook},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text
        last = r.json()
        if last["status"] in ("completed", "failed"):
            return last
        time.sleep(1)
    raise AssertionError(f"podcast job {job_id} did not finish in time; last={last}")


def _sine_wav_bytes(seconds: float = 1.0, freq: float = 440.0, rate: int = 16000) -> bytes:
    """A mono 16-bit PCM WAV of a pure sine tone, built with the stdlib only."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(seconds * rate)):
            sample = int(32767 * 0.3 * math.sin(2 * math.pi * freq * i / rate))
            frames += struct.pack("<h", sample)
        w.writeframes(bytes(frames))
    return buf.getvalue()


# ------------------------------------------------------------ dictation


def test_transcribe_returns_text_field(server):
    """A valid WAV either transcribes (200 with text/language/duration) or, if
    the STT model can't be loaded offline, returns a clean 503. A pure tone
    carries no speech, so we assert the response shape, not the text content."""
    wav = _sine_wav_bytes()
    files = {"file": ("clip.wav", wav, "audio/wav")}
    r = requests.post(f"{server}/transcribe", files=files, timeout=TIMEOUT)

    assert r.status_code in (200, 503), r.text
    if r.status_code == 200:
        body = r.json()
        assert set(body) >= {"text", "language", "duration"}
        assert isinstance(body["text"], str)
        assert isinstance(body["duration"], (int, float))


def test_transcribe_rejects_empty_upload(server):
    files = {"file": ("empty.wav", b"", "audio/wav")}
    r = requests.post(f"{server}/transcribe", files=files, timeout=TIMEOUT)
    assert r.status_code == 400


# ------------------------------------------------------------- podcast


def test_podcast_requires_a_source(server, notebook):
    r = requests.post(
        f"{server}/podcast",
        json={"source_files": [], "notebook_id": notebook},
        timeout=TIMEOUT,
    )
    assert r.status_code == 400


def test_podcast_status_unknown_job_404(server, notebook):
    r = requests.get(
        f"{server}/podcast/status",
        params={"job_id": "nope", "notebook_id": notebook},
        timeout=TIMEOUT,
    )
    assert r.status_code == 404


def test_podcast_unknown_source_fails_cleanly(server, notebook):
    """A podcast over sources with no content must reach a failed status with a
    clear error, exercising the background-job + status-polling contract and the
    graph's error short-circuit without needing Ollama or the TTS model."""
    r = requests.post(
        f"{server}/podcast",
        json={
            "source_files": ["definitely_not_a_real_source_xyz.txt"],
            "notebook_id": notebook,
        },
        timeout=TIMEOUT,
    )
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]

    final = _poll_podcast(server, job_id, notebook, timeout=60)
    assert final["status"] == "failed"
    assert (final.get("error") or final.get("message")), "expected a clear error message"


def test_podcasts_listing_is_a_list(server, notebook):
    r = requests.get(f"{server}/podcasts", params={"notebook_id": notebook}, timeout=TIMEOUT)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ------------------------------------------------------------- research


def _read_sse_until_sources(resp, max_events=200):
    """Parse an SSE stream, returning (trace_stages, sources) once the sources
    event arrives (or the stream ends). Closing early avoids waiting for the
    full local-LLM report generation."""
    import json as _json

    trace_stages = []
    sources = None
    name = ""
    data_lines = []
    seen = 0
    try:
        for raw in resp.iter_lines(decode_unicode=True):
            if raw:
                if raw.startswith("event:"):
                    name = raw[6:].strip()
                elif raw.startswith("data:"):
                    data_lines.append(raw[5:].lstrip(" "))
                continue
            if not data_lines:
                name = ""
                continue
            payload = "\n".join(data_lines)
            try:
                parsed = _json.loads(payload)
            except _json.JSONDecodeError:
                parsed = payload
            if name == "trace" and isinstance(parsed, dict):
                trace_stages.append(parsed.get("stage"))
            elif name == "sources":
                sources = parsed
            name, data_lines = "", []
            seen += 1
            if sources is not None or seen >= max_events:
                break
    finally:
        resp.close()
    return trace_stages, sources


def test_research_streams_trace_and_sources(server, notebook):
    """A research report streams trace events and a single sources event using
    the same SSE protocol as /ask. We stop at the sources event rather than
    waiting for the full report to be written."""
    # Self-contained: ensure the corpus has content to research over.
    upload(
        server,
        "research_src.txt",
        "docSeek keeps all data on the user's device for privacy. "
        "Retrieval fuses dense vectors with keyword search. "
        "A local cross-encoder reranks candidates for precision.",
        notebook=notebook,
    )

    resp = requests.post(
        f"{server}/research",
        json={
            "query": "How does docSeek retrieve and protect information?",
            "notebook_id": notebook,
        },
        stream=True,
        timeout=TIMEOUT,
    )
    assert resp.status_code == 200
    stages, sources = _read_sse_until_sources(resp)

    assert "plan" in stages
    assert "research" in stages
    # research traces come after the plan trace.
    assert stages.index("plan") < stages.index("research")
    assert isinstance(sources, list) and len(sources) >= 1
    for s in sources:
        assert set(s) >= {"id", "content", "score", "source"}
