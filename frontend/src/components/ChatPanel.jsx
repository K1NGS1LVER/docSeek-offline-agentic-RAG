import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Send, FileText, Loader2, Bot, ChevronDown, StickyNote, Mic, Square, Volume2, VolumeX, Download, Copy, Check, Trash2, Sparkles, Compass, ArrowDown, ExternalLink, CheckCircle2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { search, ask, research, getSuggestions, streamSpeech, synthesizeSpeech, getDocumentViewUrl, createDictationSocket } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import { Segmented, Chip, IconButton } from './ui';
import ClearChatModal from './ClearChatModal';

const CHAT_KEY = (id) => `ds_chat_${id}`;

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

/* ── Push-to-talk streaming dictation button (local Whisper via WebSocket) ──── */
function MicButton({ disabled, onStartDictation, onPartialText, onFinalText, onError }) {
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const dictationHandleRef = useRef(null);

  const stop = useCallback(() => {
    recordingRef.current = false;
    if (dictationHandleRef.current) {
      dictationHandleRef.current.stop();
      dictationHandleRef.current = null;
    }
    setRecording(false);
  }, []);

  useEffect(() => {
    return () => {
      recordingRef.current = false;
      if (dictationHandleRef.current) {
        dictationHandleRef.current.stop();
        dictationHandleRef.current = null;
      }
    };
  }, []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError?.('Dictation is not supported in this browser.');
      return;
    }

    onStartDictation?.();

    try {
      recordingRef.current = true;
      setRecording(true);
      const handle = await createDictationSocket(
        (partialText) => {
          if (recordingRef.current) onPartialText?.(partialText);
        },
        (finalText) => {
          if (recordingRef.current) {
            recordingRef.current = false;
            dictationHandleRef.current = null;
            onFinalText?.(finalText);
            setRecording(false);
          }
        },
        (err) => {
          recordingRef.current = false;
          dictationHandleRef.current = null;
          const errMsg = typeof err === 'string' ? err : err?.message || 'Dictation error';
          onError?.(errMsg);
          setRecording(false);
        }
      );

      if (!recordingRef.current) {
        handle.stop();
        return;
      }

      dictationHandleRef.current = handle;
    } catch (err) {
      recordingRef.current = false;
      dictationHandleRef.current = null;
      const errMsg = err?.message || 'Failed to start dictation';
      onError?.(errMsg);
      setRecording(false);
    }
  };

  const label = recording ? 'Stop recording' : 'Dictate (streaming speech-to-text)';

  return (
    <button
      type="button"
      onClick={recording ? stop : start}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-all disabled:text-disabled-fg disabled:pointer-events-none ${
        recording
          ? 'bg-caution-soft text-caution'
          : 'text-text-muted hover:text-accent hover:bg-panel'
      }`}
    >
      {recording ? (
        <Square className="w-3.5 h-3.5 fill-current animate-pulse" />
      ) : (
        <Mic className="w-4 h-4" />
      )}
    </button>
  );
}

const STAGE_CONFIG = {
  plan: { text: 'text-accent', dot: 'bg-accent', label: 'PLAN' },
  retrieve: { text: 'text-info', dot: 'bg-info', label: 'RETRIEVE' },
  rerank: { text: 'text-accent', dot: 'bg-accent', label: 'RERANK' },
  grade: { text: 'text-success', dot: 'bg-success', label: 'GRADE' },
  loop: { text: 'text-caution', dot: 'bg-caution', label: 'REFINE' },
};

/* ── Agent activity timeline with structured stepped timeline ───────── */
function AgentTrace({ trace, isStreaming }) {
  const [open, setOpen] = useState(true);
  const [collapsedOnFinish, setCollapsedOnFinish] = useState(false);

  // Auto-collapse once the answer finishes so completed turns stay tidy;
  // only ever does this once so a manual re-open sticks.
  if (!isStreaming && !collapsedOnFinish) {
    setCollapsedOnFinish(true);
    setOpen(false);
  }

  if (!trace || trace.length === 0) return null;

  return (
    <div className="bg-surface border border-border rounded-xl px-4 py-3 font-mono text-xs transition-colors">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 text-2xs tracking-[0.14em] uppercase text-text-muted hover:text-text transition-colors"
      >
        <Bot className="w-3.5 h-3.5 text-accent" />
        <span>Agent reasoning</span>
        <span className="text-text-muted/70 font-normal">
          ({trace.length} step{trace.length !== 1 ? 's' : ''})
        </span>
        {isStreaming ? (
          <span className="flex items-center gap-1.5 ml-2 text-accent">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span className="text-3xs lowercase font-mono">evaluating</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 ml-2 text-success font-mono text-3xs lowercase">
            <CheckCircle2 className="w-3 h-3" />
            <span>complete</span>
          </span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
      </button>

      {open && (
        <div className="mt-3 pl-2 relative before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-border space-y-2">
          {trace.map((ev, i) => {
            const conf = STAGE_CONFIG[ev.stage] || { text: 'text-text-muted', dot: 'bg-text-muted', label: (ev.stage || 'STAGE').toUpperCase() };
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-start gap-3 relative pl-3"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${conf.dot} absolute -left-[4px] top-1.5 ring-4 ring-surface flex-shrink-0`} />
                <span className={`w-16 flex-shrink-0 text-3xs uppercase tracking-wider font-semibold ${conf.text}`}>
                  {conf.label}
                </span>
                <span className="text-xs text-text-dim leading-relaxed min-w-0 flex-1">{ev.message}</span>
              </motion.div>
            );
          })}
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

/* Render the full message thread to Markdown for the clear-chat transcript
   download. Robust to missing fields — each message type degrades to a
   plain line rather than throwing. */
function messagesToMarkdown(messages) {
  const lines = ['# Chat transcript', ''];
  for (const m of messages) {
    if (m.type === 'query') {
      lines.push(`## Q: ${m.text || ''}`, '');
    } else if (m.type === 'answer') {
      lines.push(m.text || '_(no answer)_', '');
      if (m.sources?.length) {
        lines.push('**Sources:**');
        m.sources.forEach((s, i) => {
          lines.push(`${i + 1}. ${s.source?.filename || s.source_file || 'source'}`);
        });
        lines.push('');
      }
    } else if (m.type === 'result') {
      const results = m.results || [];
      if (results.length === 0) {
        lines.push('_(no results)_', '');
      } else {
        lines.push(`**${results.length} result${results.length !== 1 ? 's' : ''}:**`);
        results.forEach((r, i) => {
          lines.push(`${i + 1}. ${r.source?.filename || r.metadata?.filename || 'source'}`);
        });
        lines.push('');
      }
    } else if (m.type === 'error') {
      lines.push(`> Error: ${m.text || 'unknown error'}`, '');
    }
  }
  return lines.join('\n');
}

/* ── Hover-peek Citation Chip with Grounding Excerpt ─ */
function CitationChip({ index, src, notebookId }) {
  const [hovered, setHovered] = useState(false);
  const timeoutRef = useRef(null);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setHovered(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setHovered(false);
    }, 200);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!src) return <span>[{index}]</span>;

  const pct = src.score != null ? Math.round(Math.min(Math.max(src.score, 0), 1) * 100) : null;
  const filename = src.source?.filename || `chunk #${src.id}`;
  const docUrl = getDocumentViewUrl(notebookId, src.id);

  return (
    <span
      className="relative inline-block align-baseline"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <a
        className="citation-chip"
        style={{ textDecoration: 'none' }}
        href={docUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Citation ${index}: ${filename}`}
      >
        {index}
      </a>

      {hovered && (
        <span
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 sm:w-80 p-3 bg-surface border border-border-bright rounded-xl shadow-2xl z-50 text-left font-sans text-xs normal-case select-text block cursor-default"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <span className="flex items-center justify-between gap-2 pb-2 border-b border-border">
            <span className="flex items-center gap-1.5 min-w-0 flex-1 font-mono text-2xs text-text-dim truncate">
              <FileText className="w-3 h-3 text-accent flex-shrink-0" />
              <span className="truncate font-semibold text-text">{filename}</span>
              {src.source?.chunk_index != null && (
                <span className="text-text-muted flex-shrink-0">
                  · #{src.source.chunk_index + 1}
                </span>
              )}
            </span>
            {pct != null && (
              <span className="font-mono text-3xs px-1.5 py-0.5 rounded bg-accent-soft text-accent border border-accent/20 flex-shrink-0">
                {pct}% match
              </span>
            )}
          </span>

          {src.content && (
            <span className="mt-2 text-2xs text-text-dim leading-relaxed line-clamp-4 bg-panel p-2 rounded-lg border border-border/60 font-serif block italic">
              "{src.content.trim()}"
            </span>
          )}

          <span className="mt-2.5 pt-2 border-t border-border flex items-center justify-between font-mono text-3xs text-text-muted">
            <span>Grounding [{index}]</span>
            <a
              href={docUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline font-sans text-2xs font-medium"
            >
              Open source <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </span>
        </span>
      )}
    </span>
  );
}

/* ── Markdown with [n] rendered as citation chips ──── */
function AnswerMarkdown({ text, sources }) {
  const { notebookId } = useParams();
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
            return <CitationChip index={n} src={src} notebookId={notebookId} />;
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
  const { notebookId } = useParams();
  if (!sources || sources.length === 0) return null;
  return (
    <>
      {sources.map((s, i) => (
        <a
          key={i}
          href={getDocumentViewUrl(notebookId, s.id)}
          target="_blank"
          rel="noopener noreferrer"
          title={s.content?.slice(0, 300)}
          className="inline-flex items-center gap-1.5 h-7 px-3 bg-panel border border-border rounded-md font-mono text-xs text-text-dim hover:border-accent hover:text-accent transition-colors"
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
  const { notebookId } = useParams();
  const pct = Math.round(Math.min(Math.max(result.score, 0), 1) * 100);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className="bg-surface border border-border rounded-xl p-6 hover:border-border-bright transition-colors"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-20 h-1.5 bg-panel rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <span className="font-mono text-2xs text-accent">{pct}%</span>
        </div>
        <a
          href={getDocumentViewUrl(notebookId, result.id)}
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

const MODES = [
  { value: 'ask', label: 'Ask', icon: Sparkles, desc: 'Grounded Q&A' },
  { value: 'search', label: 'Search', icon: FileText, desc: 'Chunk retrieval' },
  { value: 'research', label: 'Deep Dive', icon: Compass, desc: 'Exhaustive source analysis' },
];

function ModeDropdown({ mode, setMode, disabled }) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const activeMode = MODES.find((m) => m.value === mode) || MODES[0];
  const Icon = activeMode.icon;

  return (
    <div ref={dropdownRef} className="relative flex-shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className="h-8 px-2.5 bg-accent-soft border border-accent/40 hover:border-accent hover:bg-accent/15 text-accent rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition-all focus:outline-none disabled:opacity-50 disabled:pointer-events-none"
        title="Select search or generation mode"
      >
        <Icon className="w-3.5 h-3.5" />
        <span>{activeMode.label}</span>
        <ChevronDown
          className={`w-3 h-3 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-48 bg-surface border border-border-bright rounded-xl shadow-2xl p-1.5 z-50">
          <div className="space-y-1">
            {MODES.map((m) => {
              const ItemIcon = m.icon;
              const isSelected = m.value === mode;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => {
                    setMode(m.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors ${
                    isSelected
                      ? 'bg-accent-soft text-accent font-semibold border border-accent/30'
                      : 'text-text hover:bg-surface-2'
                  }`}
                >
                  <ItemIcon className="w-3.5 h-3.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="leading-tight">{m.label}</div>
                    <div className="font-mono text-3xs text-text-muted leading-tight mt-0.5">
                      {m.desc}
                    </div>
                  </div>
                  {isSelected && (
                    <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
export default function ChatPanel({
  sourceFilter,
  selectedCount,
  totalSources,
  onSaveNote,
  onQuestionsChange,
}) {
  const { notebookId } = useParams();
  const { addLog } = useSystem();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [topK, setTopK] = useState('auto');
  const [mode, setMode] = useState('ask');
  const [micError, setMicError] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const endRef = useRef(null);
  const nextIdRef = useRef(1);
  const questionsRef = useRef([]);
  // Tracks the localStorage key the persist effect below should write to.
  // Set (together with setMessages) by the load effect whenever notebookId
  // changes, so the persist effect — keyed only on `messages` — always
  // writes the new notebook's messages to the new notebook's key, never
  // the old notebook's messages to the new key (see report for the full
  // switch sequence).
  const chatKeyRef = useRef(null);
  const skipPersistRef = useRef(true);
  const reqSeqRef = useRef(0);
  const baseInputRef = useRef('');

  const scrollContainerRef = useRef(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewTokens, setHasNewTokens] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 90;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    setIsAtBottom(atBottom);
    if (atBottom) {
      setHasNewTokens(false);
    }
  }, []);

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    endRef.current?.scrollIntoView({ behavior });
    setIsAtBottom(true);
    setHasNewTokens(false);
  }, []);

  // Load (or swap) this notebook's chat thread whenever notebookId changes,
  // including on mount.
  useEffect(() => {
    let loaded = [];
    try {
      const raw = JSON.parse(localStorage.getItem(CHAT_KEY(notebookId))) || [];
      loaded = raw.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
    } catch {
      loaded = [];
    }

    reqSeqRef.current += 1;
    chatKeyRef.current = CHAT_KEY(notebookId);
    skipPersistRef.current = true;
    setMessages(loaded);

    questionsRef.current = loaded.filter((m) => m.type === 'query').map((m) => ({ id: m.id, text: m.text }));
    onQuestionsChange?.(questionsRef.current);

    const maxId = loaded.reduce((max, m) => (m.id > max ? m.id : max), 0);
    nextIdRef.current = maxId + 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onQuestionsChange is a stable callback from the parent; re-running on its identity change would re-load the thread unnecessarily.
  }, [notebookId]);

  // Persist the thread on every change, but never mid-stream (a reload
  // should never resume showing a spinner) and always to the key recorded
  // by the load effect above — notebookId itself is deliberately not a
  // dependency here so a notebook switch cannot write stale messages under
  // the new key.
  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    if (messages.some((m) => m.isStreaming)) return;
    if (chatKeyRef.current) localStorage.setItem(chatKeyRef.current, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom('smooth');
    } else {
      setHasNewTokens(true);
    }
  }, [messages, isAtBottom, scrollToBottom]);

  useEffect(() => {
    if (!notebookId || totalSources === 0) {
      setSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }

    let active = true;
    setSuggestionsLoading(true);

    getSuggestions(notebookId)
      .then((res) => {
        if (!active) return;
        const items = Array.isArray(res?.data)
          ? res.data
          : (res?.data?.suggestions || []);
        setSuggestions(items);
      })
      .catch(() => {
        if (!active) return;
        setSuggestions([]);
      })
      .finally(() => {
        if (active) setSuggestionsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [notebookId, totalSources]);

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
    const myReq = (reqSeqRef.current += 1);
    const k = topK === 'auto' ? 5 : topK;
    const qId = nextIdRef.current++;
    setMessages((prev) => [...prev, { type: 'query', id: qId, text: query, ts: Date.now() }]);
    addQuestion(qId, query);
    setInput('');
    setIsSearching(true);
    addLog(`Query: "${query}" (k=${k})`);

    try {
      const { data, latency } = await search(notebookId, query, k, false, sourceFilter);
      if (reqSeqRef.current === myReq) {
        setMessages((prev) => [
          ...prev,
          { type: 'result', id: nextIdRef.current++, results: data, latency, query, ts: Date.now() },
        ]);
      }
      addLog(`Results: ${data.length} chunks in ${latency}ms`);
    } catch (err) {
      if (reqSeqRef.current === myReq) {
        setMessages((prev) => [
          ...prev,
          { type: 'error', id: nextIdRef.current++, text: err.message, ts: Date.now() },
        ]);
      }
      addLog(`Search error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  const handleAsk = async (query) => {
    const myReq = (reqSeqRef.current += 1);
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
        followups: [], isStreaming: true, ts: Date.now(),
      },
    ]);

    const updateLast = (patch) => {
      if (reqSeqRef.current !== myReq) return;
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
        notebookId,
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
          onFollowups: (followups) => updateLast(() => ({ followups })),
        }
      );

      updateLast(() => ({ text: data, isStreaming: false, latency }));
      addLog(`Answered in ${latency}ms`);
    } catch (err) {
      if (reqSeqRef.current === myReq) {
        setMessages((prev) => [
          ...prev,
          { type: 'error', id: nextIdRef.current++, text: err.message, ts: Date.now() },
        ]);
      }
      addLog(`Ask error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  const handleResearch = async (query) => {
    const myReq = (reqSeqRef.current += 1);
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
        followups: [], isStreaming: true, isReport: true, ts: Date.now(),
      },
    ]);

    const updateLast = (patch) => {
      if (reqSeqRef.current !== myReq) return;
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        updated[lastIdx] = { ...updated[lastIdx], ...patch(updated[lastIdx]) };
        return updated;
      });
    };

    try {
      const { data, latency } = await research(
        notebookId,
        query,
        (chunk) => updateLast(() => ({ text: chunk, isStreaming: true })),
        {
          sourceFiles: sourceFilter,
          onTrace: (ev) => {
            addLog(`Research [${ev.stage}] ${ev.message}`);
            updateLast((msg) => ({ trace: [...(msg.trace || []), ev] }));
          },
          onSources: (sources) => updateLast(() => ({ sources })),
          onFollowups: (followups) => updateLast(() => ({ followups })),
        }
      );
      updateLast(() => ({ text: data, isStreaming: false, latency }));
      addLog(`Report ready in ${latency}ms`);
    } catch (err) {
      if (reqSeqRef.current === myReq) {
        setMessages((prev) => [
          ...prev,
          { type: 'error', id: nextIdRef.current++, text: err.message, ts: Date.now() },
        ]);
      }
      addLog(`Research error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  // Clears this notebook's thread: skip the persist effect's next run (fired
  // by the setMessages([]) below) so it doesn't immediately re-create the
  // localStorage key we're about to remove as "[]".
  const clearChat = () => {
    skipPersistRef.current = true;
    setMessages([]);
    questionsRef.current = [];
    onQuestionsChange?.([]);
    nextIdRef.current = 1;
    if (chatKeyRef.current) localStorage.removeItem(chatKeyRef.current);
    setClearOpen(false);
  };

  const canType = selectedCount > 0;

  return (
    <section className="flex-1 min-w-[380px] flex flex-col relative">
      {messages.length > 0 && (
        <div className="absolute top-3 right-6 z-10">
          <IconButton
            icon={Trash2}
            onClick={() => setClearOpen(true)}
            title="Clear chat"
            className="bg-surface/80 backdrop-blur-sm border border-border/60 shadow-sm hover:bg-surface hover:text-caution"
          />
        </div>
      )}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 pt-8 pb-4"
      >
        <div className="max-w-3xl mx-auto flex flex-col gap-6 min-h-full">
          {messages.length === 0 && (
            <div className="flex-1 flex items-center justify-center py-16">
              <div className="text-center max-w-md">
                <h2 className="font-serif text-2xl text-text mb-4" style={{ textWrap: 'balance' }}>
                  Ask your sources anything.
                </h2>
                <p className="text-sm text-text-dim leading-relaxed mb-6" style={{ textWrap: 'pretty' }}>
                  <b className="text-text font-medium">Ask</b> streams an answer grounded in the
                  sources you selected — the agent plans, retrieves, and grades its own evidence.{' '}
                  <b className="text-text font-medium">Search</b> returns the raw matching chunks.{' '}
                  <b className="text-text font-medium">Research</b> writes a longer, structured report
                  with citations.
                </p>
                {totalSources > 0 && (
                  <div className="flex flex-wrap justify-center items-center gap-2">
                    {suggestionsLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                    ) : (
                      suggestions.map((q) => (
                        <Chip key={q} onClick={() => submitQuery(q)}>
                          {q}
                        </Chip>
                      ))
                    )}
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
                    {!msg.isStreaming && msg.followups?.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-border">
                        <p className="font-mono text-2xs uppercase tracking-[0.14em] text-text-muted mb-2">
                          Follow up
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {msg.followups.map((q) => (
                            <Chip key={q} onClick={() => submitQuery(q)}>
                              {q}
                            </Chip>
                          ))}
                        </div>
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

      {/* Floating Scroll-to-Bottom Sentinel */}
      {!isAtBottom && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2/95 backdrop-blur-md border border-border-bright shadow-2xl hover:border-accent hover:text-accent text-xs font-mono text-text transition-all duration-150 active:scale-95"
            title="Scroll to latest message"
          >
            <ArrowDown className="w-3.5 h-3.5 text-accent animate-bounce" />
            <span>{hasNewTokens ? 'New tokens below' : 'Scroll to bottom'}</span>
          </button>
        </div>
      )}

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
                ? 'Deep dive into your sources…'
                : mode === 'search'
                ? 'Search your sources…'
                : 'Ask your sources…'
            }
            disabled={isSearching || !canType}
            className="flex-1 min-w-0 bg-transparent text-base text-text placeholder:text-text-muted focus:outline-none disabled:text-disabled-fg"
          />
          <ModeDropdown mode={mode} setMode={setMode} disabled={isSearching || !canType} />
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
            onStartDictation={() => {
              setMicError('');
              baseInputRef.current = input.trim();
            }}
            onPartialText={(text) => {
              const base = baseInputRef.current;
              setInput(base ? `${base} ${text}` : text);
            }}
            onFinalText={(text) => {
              const base = baseInputRef.current;
              setInput(base ? `${base} ${text}` : text);
            }}
            onError={(msg) => {
              setMicError(msg);
              if (msg) addLog(`Dictation: ${msg}`, 'ERROR');
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
          <p className="text-center font-mono text-[9.5px] text-caution mt-1.5">
            {micError}
          </p>
        ) : (
          <p className="text-center font-mono text-[9.5px] text-text-muted/65 mt-1.5 select-none">
            grounded in{' '}
            <span className="text-text-muted font-normal">
              {selectedCount} of {totalSources} source{totalSources !== 1 ? 's' : ''}
            </span>{' '}
            · all local
          </p>
        )}
      </div>

      {clearOpen && (
        <ClearChatModal
          onDownload={() => downloadMarkdown('chat-transcript', messagesToMarkdown(messages))}
          onConfirm={clearChat}
          onClose={() => setClearOpen(false)}
        />
      )}
    </section>
  );
}
