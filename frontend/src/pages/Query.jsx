import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Send,
  FileText,
  ExternalLink,
  Zap,
  Loader2,
  Terminal,
  Eye,
  EyeOff,
  MessageSquare,
  Search,
  Bot,
} from 'lucide-react';
import { search, ask, getDocumentViewUrl } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import ReactMarkdown from 'react-markdown';

/* ── Score bar ─────────────────────────────────────── */
function ScoreBar({ score }) {
  const pct = Math.round(score * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-border overflow-hidden">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-accent">{pct}%</span>
    </div>
  );
}

/* ── Result chunk card ─────────────────────────────── */
function ChunkCard({ result, index, showRaw }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className="bg-carbon border border-border p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-text-muted">#{result.id}</span>
          <ScoreBar score={result.score} />
        </div>
        {result.id && (
          <a
            href={getDocumentViewUrl(result.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] font-mono text-text-muted hover:text-accent transition-colors"
          >
            VIEW <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      <p className="text-sm text-text-dim leading-relaxed">{result.content}</p>

      <div className="flex items-center gap-4 text-[10px] font-mono text-text-muted">
        {result.source?.filename && (
          <span className="flex items-center gap-1">
            <FileText className="w-3 h-3" />
            {result.source.filename}
          </span>
        )}
        {result.source?.chunk_index != null && (
          <span>chunk {result.source.chunk_index}/{result.source.total_chunks}</span>
        )}
      </div>

      {/* Raw JSON data */}
      {showRaw && (
        <details className="mt-2">
          <summary className="text-[10px] font-mono text-text-muted cursor-pointer hover:text-text-dim">
            RAW DATA
          </summary>
          <pre className="mt-2 text-[10px] font-mono text-text-muted bg-panel p-3 overflow-x-auto border border-border">
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
      )}
    </motion.div>
  );
}

/* ── Agent trace timeline ──────────────────────────── */
const STAGE_STYLES = {
  plan: 'text-accent',
  retrieve: 'text-text-dim',
  rerank: 'text-accent',
  grade: 'text-success',
  loop: 'text-caution',
};

function AgentTrace({ trace, isStreaming }) {
  if (!trace || trace.length === 0) return null;
  return (
    <div className="bg-panel border border-border px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-text-muted">
        <Bot className="w-3 h-3" />
        Agent activity
        {isStreaming && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
      </div>
      {trace.map((ev, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex items-baseline gap-2 text-[11px] font-mono"
        >
          <span className={`w-16 flex-shrink-0 uppercase ${STAGE_STYLES[ev.stage] || 'text-text-muted'}`}>
            {ev.stage}
          </span>
          <span className="text-text-dim">{ev.message}</span>
        </motion.div>
      ))}
    </div>
  );
}

/* ── Sources row (chunks the answer is grounded in) ──── */
function SourcesRow({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
        Sources
      </span>
      {sources.map((s, i) => (
        <a
          key={i}
          href={getDocumentViewUrl(s.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 bg-carbon border border-border px-2 py-1 text-[10px] font-mono text-text-dim hover:text-accent hover:border-accent/30 transition-colors"
          title={s.content?.slice(0, 300)}
        >
          <FileText className="w-3 h-3" />
          {s.source?.filename || `chunk #${s.id}`}
          <span className="text-text-muted">
            {Math.round((s.rerank_score != null ? Math.min(Math.max(s.score, 0), 1) : s.score) * 100)}%
          </span>
        </a>
      ))}
    </div>
  );
}

export default function Query() {
  const { stats, addLog } = useSystem();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [topK, setTopK] = useState('auto'); // 'auto' lets the agent pick k
  const [mode, setMode] = useState('ask');
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || isSearching) return;

    const query = input.trim();
    if (mode === 'ask') {
      await handleAsk(query);
    } else {
      await performSearch(query);
    }
  };

  const performSearch = async (query) => {
    const k = topK === 'auto' ? 5 : topK;
    setMessages((prev) => [...prev, { type: 'query', text: query, ts: Date.now() }]);
    setInput('');
    setIsSearching(true);
    addLog(`Query: "${query}" (k=${k})`);

    try {
      const { data, latency } = await search(query, k);
      setMessages((prev) => [
        ...prev,
        { type: 'result', results: data, latency, query, ts: Date.now() },
      ]);
      addLog(`Results: ${data.length} chunks in ${latency}ms`);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { type: 'error', text: err.message, ts: Date.now() },
      ]);
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

    // Insert an empty answer placeholder
    setMessages((prev) => [
      ...prev,
      { type: 'answer', text: '', trace: [], sources: [], isStreaming: true, ts: Date.now() }
    ]);

    // All updates target the streaming answer placeholder (last message).
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
          onTrace: (ev) => {
            addLog(`Agent [${ev.stage}] ${ev.message}`);
            updateLast((msg) => ({ trace: [...(msg.trace || []), ev] }));
          },
          onSources: (sources) => updateLast(() => ({ sources })),
        }
      );

      // Mark as done
      setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          updated[lastIdx] = { ...updated[lastIdx], text: data, isStreaming: false, latency };
          return updated;
      });
      addLog(`Answered in ${latency}ms`);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { type: 'error', text: err.message, ts: Date.now() },
      ]);
      addLog(`Ask error: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Controls bar */}
      <div className="h-10 border-b border-border flex items-center px-4 gap-4 flex-shrink-0 bg-panel">
        <Terminal className="w-4 h-4 text-text-muted" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
          Query Engine
        </span>
        <div className="w-px h-4 bg-border" />
        <span className="text-[10px] font-mono text-text-muted hidden md:inline">
          {stats?.total_vectors ?? 0} vectors searchable
        </span>
        <div className="flex-1" />

        {/* Mode toggle */}
        <div className="flex items-center bg-carbon border border-border p-0.5 rounded-sm shrink-0">
          <button
            onClick={() => setMode('ask')}
            className={`flex items-center gap-1.5 px-3 py-1 text-[10px] font-mono transition-colors ${
              mode === 'ask' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-dim'
            }`}
          >
            <MessageSquare className="w-3 h-3" />
            <span className="hidden sm:inline">ASK AI</span>
          </button>
          <button
            onClick={() => setMode('search')}
            className={`flex items-center gap-1.5 px-3 py-1 text-[10px] font-mono transition-colors ${
              mode === 'search' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-dim'
            }`}
          >
            <Search className="w-3 h-3" />
            <span className="hidden sm:inline">SEARCH</span>
          </button>
        </div>

        <div className="w-px h-4 bg-border hidden sm:block" />

        {/* Top K selector */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-text-muted">K=</span>
          <select
            value={topK}
            onChange={(e) => setTopK(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            className="bg-carbon border border-border px-2 py-0.5 text-[11px] font-mono text-text-dim focus:outline-none focus:border-accent/30"
          >
            <option value="auto">AUTO</option>
            {[1, 3, 5, 10].map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>

        <div className="w-px h-4 bg-border" />

        {/* Raw toggle */}
        <button
          onClick={() => setShowRaw(!showRaw)}
          className={`flex items-center gap-1.5 text-[10px] font-mono transition-colors ${
            showRaw ? 'text-accent' : 'text-text-muted hover:text-text-dim'
          }`}
        >
          {showRaw ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          RAW
        </button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
              <Zap className="w-8 h-8 text-border-bright mx-auto" />
              <p className="text-sm text-text-muted">Enter a query to search your documents</p>
              <p className="text-[10px] font-mono text-text-muted/50">
                Semantic similarity powered by FAISS + sentence-transformers
              </p>
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
                className="flex items-start gap-3"
              >
                <span className="text-accent font-mono text-sm font-bold flex-shrink-0 mt-0.5">$</span>
                <div>
                  <p className="text-sm text-text font-mono">{msg.text}</p>
                  <p className="text-[10px] text-text-muted font-mono mt-0.5">
                    {new Date(msg.ts).toLocaleTimeString('en-US', { hour12: false })}
                  </p>
                </div>
              </motion.div>
            );
          }

          if (msg.type === 'result') {
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-3"
              >
                <div className="flex items-center gap-3 text-[10px] font-mono text-text-muted">
                  <span className="text-success">→</span>
                  <span>
                    {msg.results.length} result{msg.results.length !== 1 ? 's' : ''} in {msg.latency}ms
                  </span>
                </div>

                {msg.results.length === 0 ? (
                  <div className="bg-carbon border border-border p-4">
                    <p className="text-sm text-text-muted font-mono">
                      No results above similarity threshold (0.20). Documents may not contain relevant information.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-px">
                    {msg.results.map((r, i) => (
                      <ChunkCard key={i} result={r} index={i} showRaw={showRaw} />
                    ))}
                  </div>
                )}
              </motion.div>
            );
          }

          if (msg.type === 'answer') {
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-3"
              >
                <div className="flex items-center gap-3 text-[10px] font-mono text-text-muted">
                  <span className="text-accent">~</span>
                  <span>AI Assistant {msg.latency ? `(${msg.latency}ms)` : ''}</span>
                </div>
                <AgentTrace trace={msg.trace} isStreaming={msg.isStreaming} />
                <div className="bg-carbon border border-border p-4">
                    <div className="prose prose-invert prose-sm max-w-none text-text-dim font-mono leading-relaxed prose-pre:bg-panel prose-pre:border prose-pre:border-border prose-a:text-accent">
                      <ReactMarkdown>{msg.text || "Thinking..."}</ReactMarkdown>
                      {msg.isStreaming && (
                        <span className="inline-block w-2 h-4 bg-accent animate-pulse ml-1 align-middle" />
                      )}
                    </div>
                </div>
                <SourcesRow sources={msg.sources} />
              </motion.div>
            );
          }

          if (msg.type === 'error') {
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="bg-caution/5 border border-caution/20 p-3 flex items-center gap-2"
              >
                <span className="text-caution font-mono text-sm font-bold">!</span>
                <span className="text-sm text-caution/80 font-mono">{msg.text}</span>
              </motion.div>
            );
          }
          return null;
        })}

        {isSearching && (
          <div className="flex items-center gap-2 text-accent text-xs font-mono">
            <Loader2 className="w-3 h-3 animate-spin" />
            Searching {stats?.total_vectors ?? 0} vectors...
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-4 bg-panel flex-shrink-0">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <span className="text-accent font-mono text-sm font-bold">$</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="search query..."
            disabled={isSearching}
            className="flex-1 bg-transparent text-sm font-mono text-text placeholder:text-text-muted/40 focus:outline-none"
          />
          <span className="text-[10px] font-mono text-text-muted hidden sm:block">k={topK}</span>
          <button
            type="submit"
            disabled={isSearching || !input.trim()}
            className="w-8 h-8 flex items-center justify-center bg-accent/10 text-accent hover:bg-accent hover:text-carbon disabled:opacity-20 transition-colors"
          >
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
