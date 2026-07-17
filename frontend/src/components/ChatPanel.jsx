import { useState, useRef, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Send, FileText, Loader2, Bot, ChevronDown, StickyNote, Mic, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { search, ask, transcribe, getDocumentViewUrl } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import { Segmented, Chip } from './ui';

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
export default function ChatPanel({ sourceFilter, selectedCount, totalSources, onSaveNote }) {
  const { addLog } = useSystem();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [topK, setTopK] = useState('auto');
  const [mode, setMode] = useState('ask');
  const [micError, setMicError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const { sources: allSources } = useSystem();
  const suggestions = useMemo(() => buildSuggestions(allSources), [allSources]);

  const submitQuery = async (query) => {
    if (!query.trim() || isSearching || selectedCount === 0) return;
    if (mode === 'ask') await handleAsk(query.trim());
    else await performSearch(query.trim());
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    await submitQuery(input);
  };

  const performSearch = async (query) => {
    const k = topK === 'auto' ? 5 : topK;
    setMessages((prev) => [...prev, { type: 'query', text: query, ts: Date.now() }]);
    setInput('');
    setIsSearching(true);
    addLog(`Query: "${query}" (k=${k})`);

    try {
      const { data, latency } = await search(query, k, false, sourceFilter);
      setMessages((prev) => [
        ...prev,
        { type: 'result', results: data, latency, query, ts: Date.now() },
      ]);
      addLog(`Results: ${data.length} chunks in ${latency}ms`);
    } catch (err) {
      setMessages((prev) => [...prev, { type: 'error', text: err.message, ts: Date.now() }]);
      addLog(`Search error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  const handleAsk = async (query) => {
    setMessages((prev) => [...prev, { type: 'query', text: query, ts: Date.now() }]);
    setInput('');
    setIsSearching(true);
    addLog(`Ask AI: "${query}" (k=${topK})`);

    setMessages((prev) => [
      ...prev,
      { type: 'answer', query, text: '', trace: [], sources: [], isStreaming: true, ts: Date.now() },
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
      setMessages((prev) => [...prev, { type: 'error', text: err.message, ts: Date.now() }]);
      addLog(`Ask error: ${err.message}`, 'ERROR');
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
                  <b className="text-text font-medium">Search</b> returns the raw matching chunks.
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

          {messages.map((msg, idx) => {
            if (msg.type === 'query') {
              return (
                <motion.div
                  key={idx}
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
                  key={idx}
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
                      <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-border">
                        <SourcesRow sources={msg.sources} />
                        {!msg.isStreaming && msg.text && (
                          <Chip
                            icon={StickyNote}
                            onClick={() => onSaveNote({ title: msg.query, body: msg.text })}
                            title="Save this answer to Studio notes"
                          >
                            Save to note
                          </Chip>
                        )}
                        {msg.latency != null && (
                          <span className="ml-auto font-mono text-2xs text-text-muted">
                            {msg.latency}ms
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            }

            if (msg.type === 'result') {
              return (
                <div key={idx} className="space-y-2">
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
                <div key={idx} className="bg-caution-soft border border-caution/25 rounded-xl px-4 py-3 text-sm text-caution">
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
            placeholder={canType ? 'Ask your sources…' : 'Select at least one source to ask'}
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
