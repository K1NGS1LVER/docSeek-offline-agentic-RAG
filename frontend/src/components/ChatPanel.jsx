import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Send, FileText, Loader2, Bot, ChevronDown, StickyNote, Mic, Square, Volume2, VolumeX, Download, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { search, ask, research, transcribe, streamSpeech, synthesizeSpeech, getDocumentViewUrl } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import { Segmented, Chip } from './ui';

const TTS_SAMPLE_RATE = 24000;

/* ── Read-aloud button for an answer (local Kokoro TTS, streamed) ───── */
function SpeakButton({ text }) {
  const [state, setState] = useState('idle'); // idle | loading | playing
  const audioCtxRef = useRef(null);
  const scheduledRef = useRef([]);
  const abortRef = useRef(null);
  const playHeadRef = useRef(0);
  const streamDoneRef = useRef(false);
  const fallbackAudioRef = useRef(null);
  const fallbackUrlRef = useRef(null);

  const getContext = () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  };

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    scheduledRef.current.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped/ended
      }
    });
    scheduledRef.current = [];
    streamDoneRef.current = false;
  }, []);

  const stopFallback = useCallback(() => {
    if (fallbackAudioRef.current) {
      fallbackAudioRef.current.pause();
      fallbackAudioRef.current = null;
    }
    if (fallbackUrlRef.current) {
      URL.revokeObjectURL(fallbackUrlRef.current);
      fallbackUrlRef.current = null;
    }
  }, []);

  const stopAll = useCallback(() => {
    stopStreaming();
    stopFallback();
  }, [stopStreaming, stopFallback]);

  useEffect(
    () => () => {
      stopAll();
      audioCtxRef.current?.close();
    },
    [stopAll]
  );

  // Non-streaming fallback (single WAV) for when /tts/stream itself fails
  // before any audio has played.
  const playFallback = async (clean) => {
    const url = await synthesizeSpeech(clean);
    fallbackUrlRef.current = url;
    const audio = new Audio(url);
    fallbackAudioRef.current = audio;
    audio.onended = () => {
      stopFallback();
      setState('idle');
    };
    audio.onerror = () => {
      stopFallback();
      setState('idle');
    };
    await audio.play();
    setState('playing');
  };

  const toggle = async () => {
    if (state === 'playing' || state === 'loading') {
      stopAll();
      setState('idle');
      return;
    }

    setState('loading');
    const clean = text.replace(/\[\d{1,2}\]/g, '').replace(/[#*_`>]/g, '');
    const ctx = getContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const controller = new AbortController();
    abortRef.current = controller;
    streamDoneRef.current = false;
    playHeadRef.current = ctx.currentTime + 0.05;
    let firstChunk = true;

    const scheduleChunk = (samples) => {
      if (!samples.length) return;
      const buffer = ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(playHeadRef.current, ctx.currentTime);
      source.start(startAt);
      playHeadRef.current = startAt + buffer.duration;
      scheduledRef.current.push(source);
      source.onended = () => {
        scheduledRef.current = scheduledRef.current.filter((s) => s !== source);
        if (streamDoneRef.current && scheduledRef.current.length === 0) {
          setState('idle');
        }
      };
      if (firstChunk) {
        firstChunk = false;
        setState('playing');
      }
    };

    try {
      await streamSpeech(clean, { signal: controller.signal, onSamples: scheduleChunk });
      streamDoneRef.current = true;
      if (scheduledRef.current.length === 0) setState('idle');
    } catch (err) {
      if (err.name === 'AbortError') return; // user hit Stop; already handled
      if (!firstChunk) {
        // Partial audio already played; don't restart via the fallback path.
        stopStreaming();
        setState('idle');
        return;
      }
      try {
        await playFallback(clean);
      } catch {
        stopAll();
        setState('idle');
      }
    }
  };

  const Icon = state === 'loading' ? Loader2 : state === 'playing' ? VolumeX : Volume2;
  return (
    <Chip
      icon={Icon}
      onClick={toggle}
      title={state === 'playing' ? 'Stop' : 'Read this answer aloud'}
      className={state === 'loading' ? '[&_svg]:animate-spin' : ''}
    >
      {state === 'playing' ? 'Stop' : 'Listen'}
    </Chip>
  );
}

/* ── Copy-to-clipboard button for an answer ──────────────────────────── */
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied/unavailable; nothing more we can do
    }
  };

  return (
    <Chip icon={copied ? Check : Copy} onClick={copy} title="Copy answer to clipboard">
      {copied ? 'Copied' : 'Copy'}
    </Chip>
  );
}

/* ── Push-to-talk dictation button (local Whisper via /transcribe) ──── */
function MicButton({ disabled, onText, onError }) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);

  const stop = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError?.('Dictation is not supported in this browser.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError?.('Microphone access denied. Allow the mic to dictate.');
      return;
    }
    const mr = new MediaRecorder(stream);
    chunksRef.current = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
      if (!blob.size) return;
      setTranscribing(true);
      try {
        const { data } = await transcribe(blob);
        if (data.text?.trim()) onText(data.text.trim());
        else onError?.('No speech detected — try again.');
      } catch (err) {
        onError?.(err.message || 'Transcription failed.');
      } finally {
        setTranscribing(false);
      }
    };
    mr.start();
    recorderRef.current = mr;
    setRecording(true);
  };

  const busy = transcribing;
  const label = recording ? 'Stop recording' : busy ? 'Transcribing…' : 'Dictate (local speech-to-text)';

  return (
    <button
      type="button"
      onClick={recording ? stop : start}
      disabled={disabled || busy}
      title={label}
      aria-label={label}
      className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-all disabled:text-disabled-fg disabled:pointer-events-none ${
        recording
          ? 'bg-caution-soft text-caution'
          : 'text-text-muted hover:text-accent hover:bg-panel'
      }`}
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : recording ? (
        <Square className="w-3.5 h-3.5 fill-current animate-pulse" />
      ) : (
        <Mic className="w-4 h-4" />
      )}
    </button>
  );
}

const STAGE_STYLES = {
  plan: 'text-accent',
  retrieve: 'text-text-muted',
  rerank: 'text-accent',
  grade: 'text-success',
  loop: 'text-caution',
};

/* ── Agent activity timeline ───────────────────────── */
function AgentTrace({ trace, isStreaming }) {
  const [open, setOpen] = useState(true);
  const [collapsedOnFinish, setCollapsedOnFinish] = useState(false);

  // Auto-collapse once the answer finishes so completed turns stay tidy;
  // only ever does this once so a manual re-open sticks (state adjusted
  // during render, not in an effect).
  if (!isStreaming && !collapsedOnFinish) {
    setCollapsedOnFinish(true);
    setOpen(false);
  }

  if (!trace || trace.length === 0) return null;

  return (
    <div className="bg-surface border border-border rounded-lg px-4 py-3 font-mono text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 text-2xs tracking-[0.14em] uppercase text-text-muted"
      >
        <Bot className="w-3 h-3" />
        Agent activity
        {isStreaming && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
        <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {trace.map((ev, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-baseline gap-4"
            >
              <span className={`w-16 flex-shrink-0 uppercase tracking-[0.06em] font-medium ${STAGE_STYLES[ev.stage] || 'text-text-muted'}`}>
                {ev.stage}
              </span>
              <span className="text-text-dim">{ev.message}</span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

/* Download a report as a .md file. */
function downloadMarkdown(title, text) {
  const name = `${(title || 'research-report').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60)}.md`;
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Markdown with [n] rendered as citation chips ──── */
function AnswerMarkdown({ text, sources }) {
  // Bare [n] markers (not markdown links) become internal #cite-n links,
  // then the link renderer turns those into citation chips.
  const processed = useMemo(
    () => text.replace(/\[(\d{1,2})\](?!\()/g, (_, n) => `[${n}](#cite-${n})`),
    [text]
  );

  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => {
          if (href?.startsWith('#cite-')) {
            const n = parseInt(href.slice(6), 10);
            const src = sources?.[n - 1];
            if (!src) return <span>[{children}]</span>;
            return (
              <a
                className="citation-chip"
                style={{ textDecoration: 'none' }}
                href={getDocumentViewUrl(src.id)}
                target="_blank"
                rel="noopener noreferrer"
                title={src.source?.filename || `chunk #${src.id}`}
              >
                {children}
              </a>
            );
          }
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}

/* ── Numbered source chips under an answer ─────────── */
function SourcesRow({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <>
      {sources.map((s, i) => (
        <a
          key={i}
          href={getDocumentViewUrl(s.id)}
          target="_blank"
          rel="noopener noreferrer"
          title={s.content?.slice(0, 300)}
          className="inline-flex items-center gap-1.5 h-7 px-3 bg-panel border border-border rounded-full font-mono text-xs text-text-dim hover:border-accent hover:text-accent transition-colors"
        >
          <b className="text-accent font-semibold">{i + 1}</b>
          {s.source?.filename || `chunk #${s.id}`}
          <span className="text-text-muted">
            {Math.round(Math.min(Math.max(s.score, 0), 1) * 100)}%
          </span>
        </a>
      ))}
    </>
  );
}

/* ── Collapsible sources disclosure (collapsed by default) ──────────── */
function CollapsibleSources({ sources }) {
  const [open, setOpen] = useState(false);
  if (!sources || sources.length === 0) return null;

  return (
    <div className="w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-7 px-1 -ml-1 font-mono text-2xs tracking-[0.14em] uppercase text-text-muted hover:text-accent transition-colors"
      >
        Sources ({sources.length})
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="flex flex-wrap items-center gap-2 mt-2 max-h-48 overflow-y-auto pr-1">
          <SourcesRow sources={sources} />
        </div>
      )}
    </div>
  );
}

/* ── Search result card ────────────────────────────── */
function ResultCard({ result, index }) {
  const pct = Math.round(Math.min(Math.max(result.score, 0), 1) * 100);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className="bg-surface border border-border rounded-xl p-6"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-20 h-1.5 bg-panel rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <span className="font-mono text-2xs text-accent">{pct}%</span>
        </div>
        <a
          href={getDocumentViewUrl(result.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-2xs text-text-muted hover:text-accent transition-colors"
        >
          view source ↗
        </a>
      </div>
      <p className="text-sm text-text-dim leading-relaxed">{result.content}</p>
      {result.source?.filename && (
        <div className="flex items-center gap-2 mt-3 font-mono text-2xs text-text-muted">
          <FileText className="w-3 h-3" />
          {result.source.filename}
          {result.source.chunk_index != null && (
            <span>· chunk {result.source.chunk_index}/{result.source.total_chunks}</span>
          )}
        </div>
      )}
    </motion.div>
  );
}

/* Suggested questions derived from the selected sources. */
function buildSuggestions(sources) {
  const cleaned = sources
    .slice(0, 2)
    .map((s) => s.filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim())
    .filter(Boolean);
  const items = cleaned.map((t) => `What is ${t} about?`);
  if (sources.length > 1) items.push('What topics do my sources cover?');
  items.push('Summarize the key ideas across my sources.');
  return items.slice(0, 3);
}

/* ================================================================== */
export default function ChatPanel({
  sourceFilter,
  selectedCount,
  totalSources,
  onSaveNote,
  onQuestionsChange,
}) {
  const { addLog } = useSystem();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [topK, setTopK] = useState('auto');
  const [mode, setMode] = useState('ask');
  const [micError, setMicError] = useState('');
  const endRef = useRef(null);
  const nextIdRef = useRef(1);
  const questionsRef = useRef([]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const { sources: allSources } = useSystem();
  const suggestions = useMemo(() => buildSuggestions(allSources), [allSources]);

  // Records every question asked this session, so the Studio panel's Chat
  // tab can list and jump to them. Only fires when a question is submitted,
  // never on streaming token updates.
  const addQuestion = (id, text) => {
    questionsRef.current = [...questionsRef.current, { id, text }];
    onQuestionsChange?.(questionsRef.current);
  };

  const submitQuery = async (query) => {
    if (!query.trim() || isSearching || selectedCount === 0) return;
    if (mode === 'ask') await handleAsk(query.trim());
    else if (mode === 'research') await handleResearch(query.trim());
    else await performSearch(query.trim());
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    await submitQuery(input);
  };

  const performSearch = async (query) => {
    const k = topK === 'auto' ? 5 : topK;
    const qId = nextIdRef.current++;
    setMessages((prev) => [...prev, { type: 'query', id: qId, text: query, ts: Date.now() }]);
    addQuestion(qId, query);
    setInput('');
    setIsSearching(true);
    addLog(`Query: "${query}" (k=${k})`);

    try {
      const { data, latency } = await search(query, k, false, sourceFilter);
      setMessages((prev) => [
        ...prev,
        { type: 'result', id: nextIdRef.current++, results: data, latency, query, ts: Date.now() },
      ]);
      addLog(`Results: ${data.length} chunks in ${latency}ms`);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { type: 'error', id: nextIdRef.current++, text: err.message, ts: Date.now() },
      ]);
      addLog(`Search error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  const handleAsk = async (query) => {
    const qId = nextIdRef.current++;
    setMessages((prev) => [...prev, { type: 'query', id: qId, text: query, ts: Date.now() }]);
    addQuestion(qId, query);
    setInput('');
    setIsSearching(true);
    addLog(`Ask AI: "${query}" (k=${topK})`);

    setMessages((prev) => [
      ...prev,
      {
        type: 'answer', id: nextIdRef.current++, query, text: '', trace: [], sources: [],
        isStreaming: true, ts: Date.now(),
      },
    ]);

    const updateLast = (patch) => {
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        updated[lastIdx] = { ...updated[lastIdx], ...patch(updated[lastIdx]) };
        return updated;
      });
    };

    try {
      const k = topK === 'auto' ? null : topK;
      const { data, latency } = await ask(
        query,
        k,
        (chunk) => updateLast(() => ({ text: chunk, isStreaming: true })),
        {
          sourceFiles: sourceFilter,
          onTrace: (ev) => {
            addLog(`Agent [${ev.stage}] ${ev.message}`);
            updateLast((msg) => ({ trace: [...(msg.trace || []), ev] }));
          },
          onSources: (sources) => updateLast(() => ({ sources })),
        }
      );

      updateLast(() => ({ text: data, isStreaming: false, latency }));
      addLog(`Answered in ${latency}ms`);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { type: 'error', id: nextIdRef.current++, text: err.message, ts: Date.now() },
      ]);
      addLog(`Ask error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  const handleResearch = async (query) => {
    const qId = nextIdRef.current++;
    setMessages((prev) => [...prev, { type: 'query', id: qId, text: query, ts: Date.now() }]);
    addQuestion(qId, query);
    setInput('');
    setIsSearching(true);
    addLog(`Research: "${query}"`);

    setMessages((prev) => [
      ...prev,
      {
        type: 'answer', id: nextIdRef.current++, query, text: '', trace: [], sources: [],
        isStreaming: true, isReport: true, ts: Date.now(),
      },
    ]);

    const updateLast = (patch) => {
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        updated[lastIdx] = { ...updated[lastIdx], ...patch(updated[lastIdx]) };
        return updated;
      });
    };

    try {
      const { data, latency } = await research(
        query,
        (chunk) => updateLast(() => ({ text: chunk, isStreaming: true })),
        {
          sourceFiles: sourceFilter,
          onTrace: (ev) => {
            addLog(`Research [${ev.stage}] ${ev.message}`);
            updateLast((msg) => ({ trace: [...(msg.trace || []), ev] }));
          },
          onSources: (sources) => updateLast(() => ({ sources })),
        }
      );
      updateLast(() => ({ text: data, isStreaming: false, latency }));
      addLog(`Report ready in ${latency}ms`);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { type: 'error', id: nextIdRef.current++, text: err.message, ts: Date.now() },
      ]);
      addLog(`Research error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  const canType = selectedCount > 0;

  return (
    <section className="flex-1 min-w-0 flex flex-col">
      <div className="flex-1 overflow-y-auto px-6 pt-8 pb-4">
        <div className="max-w-3xl mx-auto flex flex-col gap-6 min-h-full">
          {messages.length === 0 && (
            <div className="flex-1 flex items-center justify-center py-16">
              <div className="text-center max-w-md">
                <h2 className="font-serif text-2xl text-text mb-4">
                  Ask your sources anything.
                </h2>
                <p className="text-sm text-text-dim leading-relaxed mb-6">
                  <b className="text-text font-medium">Ask</b> streams an answer grounded in the
                  sources you selected — the agent plans, retrieves, and grades its own evidence.{' '}
                  <b className="text-text font-medium">Search</b> returns the raw matching chunks.{' '}
                  <b className="text-text font-medium">Research</b> writes a longer, structured report
                  with citations.
                </p>
                {totalSources > 0 && (
                  <div className="flex flex-wrap justify-center gap-2">
                    {suggestions.map((q) => (
                      <Chip key={q} onClick={() => submitQuery(q)}>
                        {q}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {messages.map((msg) => {
            if (msg.type === 'query') {
              return (
                <motion.div
                  key={msg.id}
                  id={`chat-q-${msg.id}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="self-end max-w-[80%] bg-accent-soft border border-accent-2 rounded-xl rounded-br-sm px-4 py-3 text-base text-text"
                >
                  {msg.text}
                </motion.div>
              );
            }

            if (msg.type === 'answer') {
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-2"
                >
                  <AgentTrace trace={msg.trace} isStreaming={msg.isStreaming} />
                  <div className="bg-surface border border-border rounded-xl p-6">
                    <div className="answer-prose">
                      {msg.text ? (
                        <AnswerMarkdown text={msg.text} sources={msg.sources} />
                      ) : (
                        <p className="text-text-muted italic">Thinking…</p>
                      )}
                      {msg.isStreaming && msg.text && (
                        <span className="inline-block w-2 h-4 bg-accent animate-pulse ml-1 align-text-bottom" />
                      )}
                    </div>
                    {(msg.sources?.length > 0 || msg.latency != null) && (
                      <div className="mt-4 pt-4 border-t border-border space-y-3">
                        <CollapsibleSources sources={msg.sources} />
                        {!msg.isStreaming && msg.text && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Chip
                              icon={StickyNote}
                              onClick={() => onSaveNote({ title: msg.query, body: msg.text })}
                              title="Save this answer to Studio notes"
                            >
                              Save to note
                            </Chip>
                            {msg.isReport && (
                              <Chip
                                icon={Download}
                                onClick={() => downloadMarkdown(msg.query, msg.text)}
                                title="Download this report as Markdown"
                              >
                                Download .md
                              </Chip>
                            )}
                            <CopyButton text={msg.text} />
                            <SpeakButton text={msg.text} />
                            {msg.latency != null && (
                              <span className="ml-auto font-mono text-2xs text-text-muted">
                                {msg.latency}ms
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            }

            if (msg.type === 'result') {
              return (
                <div key={msg.id} className="space-y-2">
                  <p className="font-mono text-xs text-text-muted">
                    {msg.results.length} result{msg.results.length !== 1 ? 's' : ''} · {msg.latency}ms
                  </p>
                  {msg.results.length === 0 ? (
                    <div className="bg-surface border border-border rounded-xl p-6 text-center">
                      <p className="text-sm text-text-dim">
                        Nothing above the similarity threshold. Try rephrasing, or check that the
                        relevant source is selected.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {msg.results.map((r, i) => (
                        <ResultCard key={i} result={r} index={i} />
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            if (msg.type === 'error') {
              return (
                <div key={msg.id} className="bg-caution-soft border border-caution/25 rounded-xl px-4 py-3 text-sm text-caution">
                  {msg.text}
                </div>
              );
            }
            return null;
          })}
          <div ref={endRef} />
        </div>
      </div>

      {/* Ask bar */}
      <div className="flex-shrink-0 px-6 pb-6 pt-2 bg-gradient-to-t from-carbon via-carbon to-transparent">
        <form
          onSubmit={handleSubmit}
          className="max-w-3xl mx-auto flex items-center gap-2 bg-surface border border-border-bright rounded-2xl p-2 pl-6 shadow-2xl"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              !canType
                ? 'Select at least one source'
                : mode === 'research'
                ? 'Research a question across your sources…'
                : mode === 'search'
                ? 'Search your sources…'
                : 'Ask your sources…'
            }
            disabled={isSearching || !canType}
            className="flex-1 min-w-0 bg-transparent text-base text-text placeholder:text-text-muted focus:outline-none disabled:text-disabled-fg"
          />
          <div className="flex-shrink-0">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'ask', label: 'Ask' },
                { value: 'search', label: 'Search' },
                { value: 'research', label: 'Research' },
              ]}
            />
          </div>
          <select
            value={topK}
            onChange={(e) => setTopK(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            className="font-mono text-xs text-text-muted bg-transparent focus:outline-none flex-shrink-0 cursor-pointer"
            title="How many chunks to retrieve — auto lets the agent decide"
          >
            <option value="auto">k · auto</option>
            {[3, 5, 10].map((k) => (
              <option key={k} value={k}>k · {k}</option>
            ))}
          </select>
          <MicButton
            disabled={isSearching || !canType}
            onText={(text) => {
              setMicError('');
              setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
            }}
            onError={(msg) => {
              setMicError(msg);
              addLog(`Dictation: ${msg}`, 'ERROR');
            }}
          />
          <button
            type="submit"
            disabled={isSearching || !input.trim() || !canType}
            title="Send"
            className="w-10 h-10 rounded-lg bg-accent text-on-accent flex items-center justify-center flex-shrink-0 hover:bg-accent-hover disabled:bg-disabled disabled:text-disabled-fg disabled:pointer-events-none transition-all"
          >
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
        {micError ? (
          <p className="text-center font-mono text-2xs uppercase tracking-[0.1em] text-caution mt-2">
            {micError}
          </p>
        ) : (
          <p className="text-center font-mono text-2xs uppercase tracking-[0.1em] text-text-muted mt-2">
            grounded in{' '}
            <b className="text-accent">
              {selectedCount} of {totalSources} source{totalSources !== 1 ? 's' : ''}
            </b>{' '}
            · all local
          </p>
        )}
      </div>
    </section>
  );
}
