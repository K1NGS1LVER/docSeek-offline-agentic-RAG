# Design Specification: Loading Hints and Animations

## 1. Goal & Context
The local-first agentic RAG application uses local models for Speech-to-Text (Whisper via `faster-whisper`), Text-to-Speech (Kokoro), and LLM generation. When these models run for the first time (or reload after an idle timeout), they lazy-load, causing multi-second delays. Currently, the UI does not provide detailed loading indicators or block the input correctly during these operations.

This design adds loading hints, button status transitions, and input-disabling features to make the application feel more responsive, premium, and robust.

---

## 2. Key Decisions & State Machine Flow
We will adopt **Approach A (State-Driven Component UI Transitions)**:

### 2.1 Speech-to-Text (`MicButton`)
The `MicButton` status transitions through a state machine:
```
[ Idle ] --(start)--> [ Connecting ] --(ws.onopen)--> [ Recording ]
                            |                                |
                            | (error)                    (stop clicked)
                            |                                |
                            v                                v
                        [ Idle ] <---(onFinalText / err)--- [ Transcribing ]
```
*   **Connecting**: Triggered when the user clicks the Mic button. The WebSocket starts connecting. The button shows a spinning spinner and tooltip `"Loading STT model..."`.
*   **Recording**: Triggered when `ws.onopen` fires. The button shows the pulsing stop square icon. The user can speak.
*   **Transcribing**: Triggered when the user clicks the Stop button. The WebSocket remains open, sending `"EOS"`. The button shows a spinning spinner and status `"Transcribing..."`. The chat input and Send button are disabled in the parent `ChatPanel`.
*   **Idle**: Reset when the final transcript is received or the connection fails.

### 2.2 Text-to-Speech (`SpeakButton`)
The `SpeakButton` transitions:
*   `idle` (displays `"Listen"`, Volume2 icon)
*   `loading` (displays `"Loading..."`, spinning Loader2 icon)
*   `playing` (displays `"Stop"`, VolumeX icon)

---

## 3. Proposed Changes

### 3.1 `frontend/src/lib/api.js`
Modify `createDictationSocket` to take a fourth parameter: `onOpen`.
```javascript
export async function createDictationSocket(onPartial, onFinal, onError, onOpen) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // ...
  const ws = new WebSocket(wsUrl);
  // ...
  ws.onopen = () => {
    mediaRecorder.start(500);
    if (onOpen) onOpen();
  };
  // ...
}
```

### 3.2 `frontend/src/components/ChatPanel.jsx`

#### 3.2.1 Update `SpeakButton`
Update the text label based on state:
```javascript
function SpeakButton({ text }) {
  // ...
  const Icon = state === 'loading' ? Loader2 : state === 'playing' ? VolumeX : Volume2;
  const label = state === 'loading' ? 'Loading...' : state === 'playing' ? 'Stop' : 'Listen';

  return (
    <Chip
      icon={Icon}
      onClick={toggle}
      title={state === 'playing' ? 'Stop' : 'Read this answer aloud'}
      className={state === 'loading' ? '[&_svg]:animate-spin' : ''}
    >
      {label}
    </Chip>
  );
}
```

#### 3.2.2 Update `MicButton`
Modify `MicButton` to manage the multi-stage `status` state:
```javascript
function MicButton({ disabled, onStartDictation, onPartialText, onFinalText, onError, onStateChange }) {
  const [status, setStatus] = useState('idle'); // idle | connecting | recording | transcribing
  const statusRef = useRef('idle');
  const dictationHandleRef = useRef(null);

  const updateStatus = (newStatus) => {
    statusRef.current = newStatus;
    setStatus(newStatus);
    onStateChange?.(newStatus);
  };

  const stop = useCallback(() => {
    if (statusRef.current === 'recording') {
      updateStatus('transcribing');
      if (dictationHandleRef.current) {
        dictationHandleRef.current.stop();
      }
    }
  }, []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError?.('Dictation is not supported in this browser.');
      return;
    }

    onStartDictation?.();
    updateStatus('connecting');

    try {
      const handle = await createDictationSocket(
        (partialText) => {
          if (statusRef.current === 'connecting' || statusRef.current === 'recording') {
            onPartialText?.(partialText);
          }
        },
        (finalText) => {
          if (statusRef.current === 'transcribing' || statusRef.current === 'recording') {
            updateStatus('idle');
            dictationHandleRef.current = null;
            onFinalText?.(finalText);
          }
        },
        (err) => {
          updateStatus('idle');
          dictationHandleRef.current = null;
          const errMsg = typeof err === 'string' ? err : err?.message || 'Dictation error';
          onError?.(errMsg);
        },
        () => {
          if (statusRef.current === 'connecting') {
            updateStatus('recording');
          }
        }
      );

      if (statusRef.current === 'idle') {
        handle.stop();
        return;
      }
      dictationHandleRef.current = handle;
    } catch (err) {
      updateStatus('idle');
      dictationHandleRef.current = null;
      onError?.(err?.message || 'Failed to start dictation');
    }
  };

  // Render buttons according to status:
  // - connecting / transcribing: Loader2 animate-spin
  // - recording: Square animate-pulse
  // - idle: Mic
}
```

#### 3.2.3 Disable Input Fields during Transcription
In `ChatPanel` parent component:
```javascript
  const [isTranscribing, setIsTranscribing] = useState(false);
  // ...
  <MicButton
    disabled={isSearching || !canType}
    onStartDictation={...}
    onPartialText={...}
    onFinalText={...}
    onError={...}
    onStateChange={(state) => setIsTranscribing(state === 'transcribing')}
  />
  // ...
  <textarea
    disabled={isSearching || !canType || isTranscribing}
    // ...
  />
```

---

## 4. Verification & Testing Plan
1. **Manual Audio Input Verification**: Verify push-to-talk connects, records, shows transcribing, disables input, and inserts final transcript successfully.
2. **First-Load Whisper Verification**: Unload Whisper model or start server fresh, trigger dictation, verify the transition `connecting` (with loader/spinner) persists while model loads, before starting `recording`.
3. **TTS (Kokoro) Verification**: Click "Listen", verify label says "Loading..." before changing to "Stop" when the audio actually plays.
