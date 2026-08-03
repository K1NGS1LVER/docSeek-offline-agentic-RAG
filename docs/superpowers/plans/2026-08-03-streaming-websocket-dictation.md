# Streaming WebSocket Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide real-time speech-to-text dictation over a local WebSocket endpoint (`/ws/transcribe`) as the user speaks into the microphone, displaying live text streaming in docSeek's query input.

**Architecture:** A FastAPI WebSocket endpoint (`/ws/transcribe`) receives binary audio frames from the browser's `MediaRecorder` (`timeslice = 500ms`), decodes and transcribes accumulated audio buffers using `faster-whisper` in non-blocking worker threads, and emits `partial` and `final` JSON transcription frames back to the React UI.

**Tech Stack:** FastAPI WebSockets, `faster-whisper` (CTranslate2), React (MediaRecorder API), pytest, `requests`/`starlette.testclient`/`websockets`.

## Global Constraints
- 100% on-device/local execution; no external cloud Speech API calls.
- Non-blocking async event loop: Whisper processing must run via threadpools (`run_in_threadpool`).
- Backward compatibility: Existing `POST /transcribe` endpoint must remain intact as a fallback.

---

### Task 1: Backend Audio Byte Buffer & Transcription Function (`app/core/stt.py`)

**Files:**
- Modify: `app/core/stt.py`
- Modify: `tests/e2e/test_media.py`

**Interfaces:**
- Consumes: Raw audio bytes or file paths.
- Produces: `transcribe_bytes(audio_bytes: bytes) -> Optional[Dict[str, Any]]`

- [ ] **Step 1: Write test for `transcribe_bytes` in `tests/e2e/test_media.py`**

```python
def test_transcribe_bytes_decodes_audio():
    """Verify transcribe_bytes accepts raw byte buffer and returns text/language dict."""
    import wave
    import io
    from app.core import stt

    # Create a 1-second silent WAV in memory
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)
    wav_bytes = buf.getvalue()

    result = stt.transcribe_bytes(wav_bytes)
    assert result is not None
    assert "text" in result
    assert "language" in result
```

- [ ] **Step 2: Run test to verify failure**

Run: `.venv/bin/python -m pytest tests/e2e/test_media.py::test_transcribe_bytes_decodes_audio -v`
Expected: FAIL with `AttributeError: module 'app.core.stt' has no attribute 'transcribe_bytes'`.

- [ ] **Step 3: Implement `transcribe_bytes` in `app/core/stt.py`**

```python
def transcribe_bytes(audio_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Transcribe raw audio bytes (WAV/WebM/OGG) to text using a temp file."""
    import tempfile
    import os

    if not audio_bytes:
        return {"text": "", "language": None, "duration": 0.0}

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        res = transcribe(tmp_path)
        return res
    finally:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/e2e/test_media.py::test_transcribe_bytes_decodes_audio -v`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add app/core/stt.py tests/e2e/test_media.py
git commit -m "feat(stt): add transcribe_bytes helper for streaming byte buffers"
```

---

### Task 2: FastAPI WebSocket Endpoint (`app/server.py`)

**Files:**
- Modify: `app/server.py`
- Modify: `tests/e2e/test_media.py`

**Interfaces:**
- Consumes: WebSocket connection at `/ws/transcribe`, receiving binary frame chunks or `"EOS"` control message.
- Produces: JSON websocket frames: `{"type": "partial", "text": "..."}`, `{"type": "final", "text": "..."}`.

- [ ] **Step 1: Write E2E test for `/ws/transcribe`**

```python
def test_websocket_transcribe_endpoint(server):
    """Test connecting to /ws/transcribe over WebSocket, sending audio bytes & EOS."""
    import websocket
    import wave
    import io
    import json

    ws_url = server.replace("http://", "ws://") + "/ws/transcribe"
    ws = websocket.create_connection(ws_url, timeout=10)

    # Send silent 1-sec WAV bytes
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)
    wav_bytes = buf.getvalue()

    ws.send_binary(wav_bytes)
    ws.send("EOS")

    res = ws.recv()
    data = json.loads(res)
    assert data["type"] in ("partial", "final")
    ws.close()
```

- [ ] **Step 2: Run test to verify failure**

Run: `.venv/bin/python -m pytest tests/e2e/test_media.py::test_websocket_transcribe_endpoint -v`
Expected: FAIL with connection error (endpoint 404 / connection refused).

- [ ] **Step 3: Implement `@app.websocket("/ws/transcribe")` in `app/server.py`**

```python
@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    await websocket.accept()
    if not stt.is_available():
        await websocket.send_json({"type": "error", "message": "STT model unavailable."})
        await websocket.close()
        return

    buffer = bytearray()
    try:
        while True:
            message = await websocket.receive()
            if "bytes" in message and message["bytes"]:
                buffer.extend(message["bytes"])
                if len(buffer) > 16000 * 2:  # >1 sec worth of audio
                    res = await run_in_threadpool(stt.transcribe_bytes, bytes(buffer))
                    if res and res.get("text"):
                        await websocket.send_json({"type": "partial", "text": res["text"]})
            elif "text" in message and message["text"] == "EOS":
                res = await run_in_threadpool(stt.transcribe_bytes, bytes(buffer))
                text = res.get("text", "") if res else ""
                await websocket.send_json({"type": "final", "text": text})
                break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket STT error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/e2e/test_media.py::test_websocket_transcribe_endpoint -v`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add app/server.py tests/e2e/test_media.py
git commit -m "feat(server): add /ws/transcribe WebSocket dictation endpoint"
```

---

### Task 3: Frontend API Helper & WebSocket MediaRecorder Client (`frontend/src/lib/api.js`)

**Files:**
- Modify: `frontend/src/lib/api.js`

**Interfaces:**
- Consumes: Audio MediaStream from browser `getUserMedia`.
- Produces: `createDictationSocket(onPartial, onFinal, onError) -> { stop: () => void }`

- [ ] **Step 1: Write helper function `createDictationSocket` in `frontend/src/lib/api.js`**

```javascript
/**
 * Stream audio chunks over WebSocket to /ws/transcribe in real time.
 * @param {Function} onPartial - Callback receiving partial transcript text.
 * @param {Function} onFinal - Callback receiving final transcript text.
 * @param {Function} onError - Callback receiving error message.
 * @returns {Promise<{ stop: Function }>} Control object to stop streaming.
 */
export async function createDictationSocket(onPartial, onFinal, onError) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws/transcribe';
  const ws = new WebSocket(wsUrl);

  const mediaRecorder = new MediaRecorder(stream);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'partial' && onPartial) onPartial(data.text);
      if (data.type === 'final' && onFinal) onFinal(data.text);
      if (data.type === 'error' && onError) onError(data.message);
    } catch (e) {
      console.error('STT WebSocket parse error:', e);
    }
  };

  ws.onerror = (err) => {
    if (onError) onError('WebSocket connection error');
  };

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
      const buffer = await event.data.arrayBuffer();
      ws.send(buffer);
    }
  };

  ws.onopen = () => {
    mediaRecorder.start(500); // 500ms slice
  };

  return {
    stop: () => {
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      stream.getTracks().forEach((track) => track.stop());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('EOS');
      }
    },
  };
}
```

- [ ] **Step 2: Commit changes**

```bash
git add frontend/src/lib/api.js
git commit -m "feat(frontend): add createDictationSocket for WebSocket streaming dictation"
```

---

### Task 4: UI Integration in `ChatPanel.jsx` (`frontend/src/components/ChatPanel.jsx`)

**Files:**
- Modify: `frontend/src/components/ChatPanel.jsx`

**Interfaces:**
- Consumes: `createDictationSocket` from `../lib/api`.
- Produces: Interactive dictation toggle button with real-time text updating in query state.

- [ ] **Step 1: Update dictation handler in `ChatPanel.jsx`**

```javascript
// Replace static transcribe call with live streaming dictation
const [dictationHandle, setDictationHandle] = useState(null);

const toggleDictation = async () => {
  if (isRecording && dictationHandle) {
    dictationHandle.stop();
    setDictationHandle(null);
    setIsRecording(false);
    return;
  }

  try {
    setIsRecording(true);
    const handle = await createDictationSocket(
      (partialText) => setQueryText(partialText),
      (finalText) => {
        setQueryText(finalText);
        setIsRecording(false);
        setDictationHandle(null);
      },
      (err) => {
        console.error('Dictation error:', err);
        setIsRecording(false);
        setDictationHandle(null);
      }
    );
    setDictationHandle(handle);
  } catch (err) {
    console.error('Failed to start dictation:', err);
    setIsRecording(false);
  }
};
```

- [ ] **Step 2: Verify frontend build**

Run: `cd frontend && npm run build`
Expected: Clean build without errors or warnings.

- [ ] **Step 3: Commit changes**

```bash
git add frontend/src/components/ChatPanel.jsx
git commit -m "feat(ui): integrate streaming dictation in ChatPanel query input"
```
