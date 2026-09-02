import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Loader2,
  Mic,
  Download,
  AlertCircle,
  X,
  RefreshCw,
  FileText,
  BookOpen,
  HelpCircle,
  Clock,
  Copy,
  Check,
  StickyNote,
  ArrowLeft,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useSystem } from '../lib/SystemContext';
import { getPodcastAudioUrl, getMemoryStats, clearMemory, generateArtifact } from '../lib/api';
import { Button, IconButton, SectionLabel, Segmented, inputCls, textareaCls } from './ui';

function NoteCard({ note, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="group bg-panel border border-border rounded-xl p-4 cursor-pointer hover:border-border-bright hover:-translate-y-px transition-all duration-200"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-serif text-base font-medium text-text min-w-0 break-words">
          {note.title || 'Untitled note'}
        </h4>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(note.id);
          }}
          title="Delete note"
          className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-caution transition-all flex-shrink-0 mt-1"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className={`text-sm text-text-dim mt-1 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}>
        {note.body}
      </p>
      <div className="font-mono text-2xs text-text-muted mt-2">{note.meta}</div>
    </div>
  );
}

function NotesTab({ notes, onAdd, onDelete }) {
  const [drafting, setDrafting] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const saveDraft = () => {
    if (!body.trim() && !title.trim()) return;
    onAdd({ title: title.trim() || 'Untitled note', body: body.trim() });
    setTitle('');
    setBody('');
    setDrafting(false);
  };

  return (
    <div className="flex flex-col gap-4">
      {drafting ? (
        <div className="bg-panel border border-border rounded-xl p-4 space-y-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Note title"
            className={inputCls}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Write something worth keeping…"
            className={textareaCls}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDrafting(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveDraft} disabled={!body.trim() && !title.trim()}>
              Save note
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" icon={Plus} onClick={() => setDrafting(true)} className="w-full">
          Add note
        </Button>
      )}

      {notes.length === 0 && !drafting && (
        <div className="text-center px-4 py-8">
          <p className="text-sm text-text-muted">
            Notes live here.
          </p>
          <p className="text-xs text-text-dim mt-1">
            Save an answer from the chat or write your own.
          </p>
        </div>
      )}
      {notes.map((n) => (
        <NoteCard key={n.id} note={n} onDelete={onDelete} />
      ))}
    </div>
  );
}

/* ── Audio overview (local two-host podcast) ────────── */

function fmtDuration(seconds) {
  if (!seconds || seconds < 1) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function EpisodeCard({ ep }) {
  const { notebookId } = useParams();
  return (
    <div className="bg-panel border border-border rounded-xl p-4">
      <h4 className="font-serif text-base font-medium text-text break-words">
        {ep.title || 'Audio overview'}
      </h4>
      <div className="font-mono text-2xs text-text-muted mt-1">
        {fmtDuration(ep.duration)} · {ep.turns} turns
        {ep.source_files?.length ? ` · ${ep.source_files.length} source${ep.source_files.length !== 1 ? 's' : ''}` : ''}
      </div>
      <audio
        controls
        preload="none"
        src={getPodcastAudioUrl(notebookId, ep.job_id)}
        className="w-full mt-3 h-9"
      />
      <a
        href={getPodcastAudioUrl(notebookId, ep.job_id)}
        download={`${(ep.title || 'audio-overview').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.wav`}
        className="inline-flex items-center gap-1.5 mt-2 font-mono text-2xs text-text-muted hover:text-accent transition-colors"
      >
        <Download className="w-3 h-3" />
        download wav
      </a>
    </div>
  );
}

function AudioTab({ selectedSources }) {
  // Job state lives in SystemContext so it survives Studio tab switches and
  // page reloads; this component is just the view.
  const { podcastJob, podcasts, startPodcast, dismissPodcastJob, addLog } = useSystem();
  const [startError, setStartError] = useState('');

  const generating = podcastJob?.status === 'running';
  const failed = podcastJob?.status === 'failed';
  const error = startError || (failed ? (podcastJob.error || podcastJob.message) : '');

  const generate = async () => {
    setStartError('');
    if (selectedSources.length === 0) {
      setStartError('Select at least one source first.');
      return;
    }
    try {
      addLog(`Generating podcast from ${selectedSources.length} source(s)…`);
      await startPodcast(selectedSources);
    } catch (e) {
      setStartError(e.message || 'Could not start generation.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-panel border border-border rounded-xl p-4">
        <SectionLabel className="mb-1">Audio overview</SectionLabel>
        <p className="text-sm text-text-dim leading-relaxed mb-3">
          Turn your selected sources into a two-host podcast — generated and voiced entirely on-device.
        </p>
        <Button
          icon={Mic}
          busy={generating}
          onClick={generate}
          disabled={generating || selectedSources.length === 0}
          className="w-full"
        >
          {generating ? 'Generating…' : 'Generate podcast'}
        </Button>
        <p className="font-mono text-2xs text-text-muted mt-2 text-center">
          {generating
            ? 'runs in the background — you can switch tabs'
            : selectedSources.length === 0
            ? 'select at least one source'
            : `from ${selectedSources.length} selected source${selectedSources.length !== 1 ? 's' : ''} · takes a few minutes`}
        </p>
      </div>

      {generating && (
        <div className="bg-panel border border-accent/30 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between font-mono text-2xs text-accent">
            <span className="flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              {podcastJob.stage || 'working'}
            </span>
            <span className="text-text-muted">{podcastJob.progress ?? 0}%</span>
          </div>
          <div className="h-1 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${podcastJob.progress ?? 0}%` }}
            />
          </div>
          {podcastJob.message && <p className="text-xs text-text-dim">{podcastJob.message}</p>}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-caution-soft border border-caution/25 rounded-xl px-4 py-3 text-sm text-caution">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          {failed && (
            <button onClick={dismissPodcastJob} title="Dismiss" className="flex-shrink-0 hover:text-text">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {podcasts.length === 0 && !generating ? (
        <div className="text-center px-4 py-6">
          <p className="text-sm text-text-muted">No episodes yet.</p>
          <p className="text-xs text-text-dim mt-1">Generate one from your sources above.</p>
        </div>
      ) : (
        podcasts.map((ep) => <EpisodeCard key={ep.job_id} ep={ep} />)
      )}
    </div>
  );
}

function StatTile({ label, value, suffix }) {
  return (
    <div className="bg-panel border border-border rounded-xl p-4">
      <div className="font-mono text-2xs tracking-[0.12em] uppercase text-text-muted mb-2">
        {label}
      </div>
      <div className="font-serif text-2xl font-medium text-text leading-none">
        {value ?? '—'}
        {suffix && value != null && (
          <span className="font-mono text-xs text-text-muted ml-1">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function FactRow({ k, v, accentClass = 'text-text-dim' }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="font-mono text-xs text-text-muted flex-shrink-0">{k}</span>
      <span className={`font-mono text-xs text-right truncate ${accentClass}`}>{v ?? '—'}</span>
    </div>
  );
}

function EngineTab() {
  const { stats, lastLatency, logs, ingestStatus } = useSystem();
  const [latencyHistory, setLatencyHistory] = useState([]);
  const [prevLatency, setPrevLatency] = useState(null);
  const [memoryStats, setMemoryStats] = useState(null);
  const [clearingMem, setClearingMem] = useState(false);

  // Track latency samples (state adjusted during render, not in an effect).
  if (lastLatency != null && lastLatency !== prevLatency) {
    setPrevLatency(lastLatency);
    setLatencyHistory((prev) => [...prev.slice(-29), lastLatency]);
  }

  const fetchMemory = async () => {
    try {
      const { data } = await getMemoryStats();
      setMemoryStats(data);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchMemory();
    const interval = setInterval(fetchMemory, 8000);
    return () => clearInterval(interval);
  }, []);

  const handlePurge = async () => {
    setClearingMem(true);
    try {
      await clearMemory();
      await fetchMemory();
    } finally {
      setClearingMem(false);
    }
  };

  const avg = latencyHistory.length
    ? Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length)
    : null;
  const maxSample = Math.max(...latencyHistory, 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="Documents" value={stats?.total_documents} />
        <StatTile label="Vectors" value={stats?.total_vectors} />
        <StatTile label="Dimension" value={stats?.dimension} />
        <StatTile label="Last query" value={lastLatency} suffix="ms" />
      </div>

      {ingestStatus?.is_ingesting && (
        <div className="bg-panel border border-accent/30 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between font-mono text-2xs text-accent">
            <span className="flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              ingesting
            </span>
            <span className="text-text-muted">
              {ingestStatus.progress}/{ingestStatus.total}
            </span>
          </div>
          <div className="h-1 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: `${ingestStatus.total ? (ingestStatus.progress / ingestStatus.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="bg-panel border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>Memory & Footprint</SectionLabel>
          <button
            type="button"
            onClick={handlePurge}
            disabled={clearingMem}
            className="text-2xs font-mono text-text-muted hover:text-accent flex items-center gap-1 transition-colors px-1.5 py-0.5 rounded hover:bg-surface-2"
            title="Purge PyTorch caching allocators and unload idle models"
          >
            <RefreshCw className={`w-3 h-3 ${clearingMem ? 'animate-spin text-accent' : ''}`} />
            <span>Purge</span>
          </button>
        </div>
        <FactRow k="process ram" v={memoryStats?.rss_mb ? `${memoryStats.rss_mb} MB` : 'checking...'} />
        <FactRow k="peak ram" v={memoryStats?.peak_mb ? `${memoryStats.peak_mb} MB` : null} />
        <FactRow k="ollama keep-alive" v={memoryStats?.llm_keep_alive || '5m'} />
        <FactRow
          k="audio models"
          v={memoryStats?.tts_loaded || memoryStats?.stt_loaded ? 'active' : 'unloaded (idle)'}
          accentClass={memoryStats?.tts_loaded || memoryStats?.stt_loaded ? 'text-accent' : 'text-text-dim'}
        />
      </div>

      <div className="bg-panel border border-border rounded-xl p-4">
        <SectionLabel className="mb-2">Pipeline</SectionLabel>
        <FactRow k="embedder" v={stats ? `${stats.model?.split('/').pop()} · ${stats.dimension}d` : null} />
        <FactRow k="index" v="FAISS IDMap · FlatIP" />
        <FactRow k="retrieval" v={stats?.hybrid_search ? 'dense + bm25 · rrf' : 'dense only'} />
        <FactRow k="reranker" v={stats?.reranker_model?.split('/').pop()} />
        <FactRow
          k="agent"
          v={stats?.agentic ? 'on' : 'off'}
          accentClass={stats?.agentic ? 'text-success' : 'text-text-dim'}
        />
        <FactRow k="chunking" v={stats?.chunking_strategy} />
      </div>

      <div className="bg-panel border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>Latency</SectionLabel>
          <span className="font-mono text-2xs text-text-muted">
            {avg != null ? `avg ${avg}ms` : ''}
          </span>
        </div>
        {latencyHistory.length === 0 ? (
          <p className="text-xs text-text-muted">No samples yet — run a few queries.</p>
        ) : (
          <div className="flex items-end gap-1 h-10">
            {latencyHistory.map((v, i) => (
              <div
                key={i}
                title={`${v}ms`}
                className="flex-1 bg-accent opacity-55 hover:opacity-100 rounded-t-sm min-h-1 transition-opacity"
                style={{ height: `${(v / maxSample) * 100}%` }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="bg-panel border border-border rounded-xl p-4">
        <SectionLabel className="mb-2">Session log · {logs.length}</SectionLabel>
        <div className="font-mono text-2xs max-h-48 overflow-y-auto space-y-1">
          {logs.length === 0 && <p className="text-text-muted">No entries yet.</p>}
          {[...logs].reverse().map((log, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-text-muted flex-shrink-0">{log.ts}</span>
              <span
                className={
                  log.level === 'ERROR' ? 'text-caution' :
                  log.level === 'WARN' ? 'text-accent' : 'text-text-dim'
                }
              >
                {log.msg}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Chat tab: jump-to-question nav for the current conversation ────── */
function ChatTab({ questions }) {
  const [activeId, setActiveId] = useState(null);

  useEffect(() => {
    if (questions.length === 0) return undefined;
    const targets = questions
      .map((q) => document.getElementById(`chat-q-${q.id}`))
      .filter(Boolean);
    if (targets.length === 0) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const topMost = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b
        );
        setActiveId(Number(topMost.target.id.replace('chat-q-', '')));
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 }
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [questions]);

  if (questions.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-text-muted">No questions yet.</p>
        <p className="text-xs text-text-dim mt-1">Ask something to build a jump list here.</p>
      </div>
    );
  }

  const jumpTo = (id) => {
    document.getElementById(`chat-q-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-1">
      <SectionLabel className="px-3 mb-1">Questions</SectionLabel>
      {questions.map((q, i) => (
        <button
          key={q.id}
          type="button"
          onClick={() => jumpTo(q.id)}
          className={`w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg text-sm transition-colors border ${
            activeId === q.id
              ? 'bg-accent-soft text-accent border-accent-2'
              : 'text-text-dim border-transparent hover:bg-panel'
          }`}
        >
          <span className="font-mono text-2xs text-text-muted flex-shrink-0 mt-0.5">{i + 1}</span>
          <span className="line-clamp-2">{q.text}</span>
        </button>
      ))}
    </div>
  );
}

/* ── Artifacts Generator ────────────────────────────── */

function downloadMarkdown(title, text) {
  const name = `${(title || 'artifact').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60)}.md`;
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const ARTIFACT_TYPES = [
  {
    type: 'briefing',
    label: 'Briefing Doc',
    icon: FileText,
    desc: 'A structured executive summary of your sources.',
  },
  {
    type: 'study_guide',
    label: 'Study Guide',
    icon: BookOpen,
    desc: 'Key concepts, vocabulary, review questions, and essay prompts.',
  },
  {
    type: 'faq',
    label: 'FAQ',
    icon: HelpCircle,
    desc: 'Frequently asked questions with grounded answers.',
  },
  {
    type: 'timeline',
    label: 'Timeline',
    icon: Clock,
    desc: 'Chronological sequence of events and milestones.',
  },
];

const ARTIFACTS_KEY_PREFIX = 'ds_artifacts_';
const artifactsKey = (id) => `${ARTIFACTS_KEY_PREFIX}${id || 'default'}`;
const LEGACY_ARTIFACT_KEY_PREFIX = 'ds_artifact_';
const legacyArtifactKey = (id) => `${LEGACY_ARTIFACT_KEY_PREFIX}${id || 'default'}`;

function loadSavedArtifacts(key, legacyKey) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    // Backward compatibility: check if single artifact was saved previously
    const legacyRaw = localStorage.getItem(legacyKey);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && legacy.content) {
        const item = {
          id: `art_${Date.now()}`,
          type: legacy.type || 'briefing',
          title: legacy.title || 'Generated Artifact',
          content: legacy.content,
          focus: legacy.focus || '',
          createdAt: Date.now(),
        };
        localStorage.setItem(key, JSON.stringify([item]));
        return [item];
      }
    }
    return [];
  } catch {
    return [];
  }
}

function ArtifactsTab({ selectedSources = [], onAddNote }) {
  const { notebookId } = useParams();
  const storageKey = artifactsKey(notebookId);
  const legacyStorageKey = legacyArtifactKey(notebookId);

  const [artifacts, setArtifacts] = useState(() =>
    loadSavedArtifacts(storageKey, legacyStorageKey)
  );
  const [activeArtifactId, setActiveArtifactId] = useState(null);
  const [focus, setFocus] = useState('');
  const [refinePrompt, setRefinePrompt] = useState('');
  const [generating, setGenerating] = useState(null);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [savedToNotes, setSavedToNotes] = useState(false);

  // Sync artifacts array to localStorage so documents persist across tab switches, collapse, or reload
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(artifacts));
    } catch {
      // ignore
    }
  }, [artifacts, storageKey]);

  const activeArtifact = artifacts.find((a) => a.id === activeArtifactId) || null;

  const handleGenerate = useCallback(async (type) => {
    if (selectedSources.length === 0) return;
    setError(null);
    setGenerating(type);
    setStreamText('');

    const typeConfig = ARTIFACT_TYPES.find((t) => t.type === type);
    const timestamp = new Date().getTime();
    const newId = `art_${timestamp}`;
    let finalResult = null;
    let accumulated = '';

    // Switch view to full sidebar reader immediately so user sees the live stream
    setActiveArtifactId(newId);

    try {
      await generateArtifact(notebookId, type, focus.trim(), {
        onData: (chunk) => {
          accumulated += chunk;
          setStreamText((prev) => prev + chunk);
        },
        onDone: (data) => {
          finalResult = {
            id: newId,
            type,
            title: data.title || typeConfig?.label || 'Artifact',
            content: data.full_text || accumulated,
            focus: focus.trim(),
            createdAt: timestamp,
          };
          setArtifacts((prev) => [finalResult, ...prev]);
          setGenerating(null);
          setStreamText('');
        },
      });

      if (!finalResult && accumulated) {
        const item = {
          id: newId,
          type,
          title: typeConfig?.label || 'Artifact',
          content: accumulated,
          focus: focus.trim(),
          createdAt: timestamp,
        };
        setArtifacts((prev) => [item, ...prev]);
        setGenerating(null);
        setStreamText('');
      }
    } catch (err) {
      setError(err.message || 'Failed to generate artifact.');
      setGenerating(null);
      setActiveArtifactId(null);
    }
  }, [focus, notebookId, selectedSources.length]);

  const handleRefine = useCallback(async () => {
    if (!activeArtifact || !refinePrompt.trim() || selectedSources.length === 0) return;
    setError(null);
    setGenerating('refine');
    setStreamText('');

    let accumulated = '';
    let finalContent = '';
    const userPrompt = refinePrompt.trim();
    const combinedFocus = `Refine and update this ${activeArtifact.title}. Instructions: ${userPrompt}`;
    const updateTime = new Date().getTime();

    try {
      await generateArtifact(notebookId, activeArtifact.type || 'briefing', combinedFocus, {
        onData: (chunk) => {
          accumulated += chunk;
          setStreamText((prev) => prev + chunk);
        },
        onDone: (data) => {
          finalContent = data.full_text || accumulated;
          setArtifacts((prev) =>
            prev.map((art) =>
              art.id === activeArtifact.id
                ? {
                    ...art,
                    content: finalContent,
                    title: data.title || art.title,
                    updatedAt: updateTime,
                  }
                : art
            )
          );
          setGenerating(null);
          setStreamText('');
          setRefinePrompt('');
        },
      });

      if (!finalContent && accumulated) {
        setArtifacts((prev) =>
          prev.map((art) =>
            art.id === activeArtifact.id
              ? {
                  ...art,
                  content: accumulated,
                  updatedAt: updateTime,
                }
              : art
          )
        );
        setGenerating(null);
        setStreamText('');
        setRefinePrompt('');
      }
    } catch (err) {
      setError(err.message || 'Failed to refine artifact.');
      setGenerating(null);
    }
  }, [activeArtifact, notebookId, refinePrompt, selectedSources.length]);

  const handleCopy = async (content) => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleSaveToNotes = (artifact) => {
    if (!artifact?.content) return;
    onAddNote?.({
      title: artifact.title || 'Generated Artifact',
      body: artifact.content,
    });
    setSavedToNotes(true);
    setTimeout(() => setSavedToNotes(false), 2000);
  };

  const handleDelete = (id, e) => {
    e?.stopPropagation?.();
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
    if (activeArtifactId === id) {
      setActiveArtifactId(null);
      setStreamText('');
      setGenerating(null);
    }
  };

  // If in full-sidebar reader view (viewing or generating a specific document)
  if (activeArtifactId !== null) {
    const displayTitle = activeArtifact?.title || (generating && ARTIFACT_TYPES.find((t) => t.type === generating)?.label) || 'Document';
    const displayContent = streamText || activeArtifact?.content || '';
    const activeConfig = ARTIFACT_TYPES.find((t) => t.type === activeArtifact?.type);
    const IconComponent = activeConfig?.icon || FileText;

    return (
      <div className="flex flex-col h-full gap-3 select-text">
        {/* Header with Back, Title, and Actions */}
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-border/80 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <IconButton
              icon={ArrowLeft}
              size="sm"
              onClick={() => {
                setActiveArtifactId(null);
                setStreamText('');
                setError(null);
              }}
              title="Back to artifacts"
            />
            <div className="p-1.5 rounded-md bg-surface-2 border border-border/60 text-accent flex-shrink-0">
              <IconComponent className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-serif text-sm font-medium text-text truncate leading-tight">
                {displayTitle}
              </h3>
              {activeArtifact?.createdAt && (
                <p className="font-mono text-3xs text-text-dim mt-0.5">
                  {new Date(activeArtifact.updatedAt || activeArtifact.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {activeArtifact.updatedAt ? ' (customized)' : ''}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {activeArtifact && (
              <>
                <IconButton
                  icon={savedToNotes ? Check : StickyNote}
                  size="sm"
                  onClick={() => handleSaveToNotes(activeArtifact)}
                  title={savedToNotes ? 'Saved to notes!' : 'Save to notes'}
                />
                <IconButton
                  icon={copied ? Check : Copy}
                  size="sm"
                  onClick={() => handleCopy(displayContent)}
                  title={copied ? 'Copied' : 'Copy markdown'}
                />
                <IconButton
                  icon={Download}
                  size="sm"
                  onClick={() => downloadMarkdown(displayTitle, displayContent)}
                  title="Download .md"
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  onClick={(e) => handleDelete(activeArtifact.id, e)}
                  title="Delete artifact"
                />
              </>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-caution-soft border border-caution/25 rounded-xl px-3 py-2 text-xs text-caution flex-shrink-0">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} title="Dismiss" className="flex-shrink-0 hover:text-text">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Full-Height Scrollable Markdown Content */}
        <div className="flex-1 overflow-y-auto bg-panel border border-border/70 rounded-xl p-4 text-xs text-text leading-relaxed prose prose-invert max-w-none">
          {generating && !displayContent && (
            <div className="flex items-center justify-center h-32 gap-2 text-text-muted">
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
              <span className="text-xs">Generating document from sources…</span>
            </div>
          )}
          {displayContent ? (
            <ReactMarkdown>{displayContent}</ReactMarkdown>
          ) : null}
        </div>

        {/* Bottom Customization / Refine Bar */}
        <div className="pt-2 border-t border-border/80 flex-shrink-0 space-y-2">
          <SectionLabel>Customize this document</SectionLabel>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={refinePrompt}
              onChange={(e) => setRefinePrompt(e.target.value)}
              placeholder="e.g. Make it shorter, add key takeaways, simplify..."
              className={`${inputCls} flex-1 text-xs`}
              disabled={Boolean(generating)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleRefine();
                }
              }}
            />
            <Button
              size="sm"
              variant="accent"
              disabled={!refinePrompt.trim() || Boolean(generating) || selectedSources.length === 0}
              busy={generating === 'refine'}
              onClick={handleRefine}
            >
              Refine
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Main List & Generator View (activeArtifactId === null)
  return (
    <div className="flex flex-col gap-5 select-text pb-4">
      {/* Top Generator Section */}
      <div className="space-y-2.5">
        <SectionLabel>Focus / Instructions (optional)</SectionLabel>
        <input
          type="text"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="e.g. key risks, timeline from 2020, technical vocabulary..."
          className={inputCls}
          disabled={Boolean(generating)}
        />
        {selectedSources.length === 0 ? (
          <p className="font-mono text-2xs text-caution text-center">
            Select at least one source first
          </p>
        ) : (
          <p className="font-mono text-2xs text-text-muted text-center">
            from {selectedSources.length} selected source{selectedSources.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-caution-soft border border-caution/25 rounded-xl px-4 py-3 text-sm text-caution">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} title="Dismiss" className="flex-shrink-0 hover:text-text">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Generator Cards */}
      <div className="grid grid-cols-1 gap-2">
        {ARTIFACT_TYPES.map((item) => (
          <div
            key={item.type}
            className="bg-panel border border-border rounded-xl p-3.5 flex flex-col justify-between gap-2.5 hover:border-border-bright transition-colors"
          >
            <div className="flex items-start gap-2.5">
              <div className="p-2 rounded-lg bg-surface-2 border border-border/60 text-accent flex-shrink-0 mt-0.5">
                <item.icon className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-medium text-text">{item.label}</h4>
                <p className="text-xs text-text-dim mt-0.5 leading-relaxed">{item.desc}</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedSources.length === 0 || Boolean(generating)}
              busy={generating === item.type}
              onClick={() => handleGenerate(item.type)}
              className="w-full"
            >
              {generating === item.type ? 'Generating…' : `Generate ${item.label}`}
            </Button>
          </div>
        ))}
      </div>

      {/* Created Documents Section (closed compact cards) */}
      <div className="space-y-2 pt-2 border-t border-border/80">
        <div className="flex items-center justify-between">
          <SectionLabel>Created Documents ({artifacts.length})</SectionLabel>
        </div>

        {artifacts.length === 0 ? (
          <div className="p-4 rounded-xl border border-dashed border-border/80 text-center">
            <p className="text-xs text-text-dim">
              No documents created yet. Choose a format above to generate one.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {artifacts.map((art) => {
              const config = ARTIFACT_TYPES.find((t) => t.type === art.type);
              const IconComp = config?.icon || FileText;
              return (
                <div
                  key={art.id}
                  onClick={() => setActiveArtifactId(art.id)}
                  className="group bg-panel border border-border rounded-xl p-3 flex items-center justify-between gap-2 cursor-pointer hover:border-border-bright hover:-translate-y-px transition-all duration-150"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="p-1.5 rounded-lg bg-surface-2 border border-border/60 text-accent flex-shrink-0">
                      <IconComp className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-xs font-medium text-text truncate group-hover:text-accent transition-colors">
                        {art.title}
                      </h4>
                      <p className="font-mono text-3xs text-text-muted mt-0.5">
                        {new Date(art.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}{' '}
                        ·{' '}
                        {new Date(art.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {art.updatedAt ? ' · customized' : ''}
                      </p>
                    </div>
                  </div>
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    onClick={(e) => handleDelete(art.id, e)}
                    title="Delete document"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function StudioPanel({
  notes,
  onAddNote,
  onDeleteNote,
  selectedSources = [],
  questions = [],
}) {
  const { notebookId } = useParams();
  const [tab, setTab] = useState('notes');
  const [autoSwitched, setAutoSwitched] = useState(false);

  // Jump straight to the question list the first time a conversation
  // starts, without fighting a manual tab switch afterward (state adjusted
  // during render, not in an effect).
  if (questions.length > 0 && !autoSwitched) {
    setAutoSwitched(true);
    setTab('chat');
  }

  return (
    <aside className="w-full h-full flex-shrink-0 bg-surface border-l border-border flex flex-col min-h-0 overflow-hidden select-text">
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <Segmented
          block
          value={tab}
          onChange={setTab}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'notes', label: 'Notes' },
            { value: 'artifacts', label: 'Artifacts' },
            { value: 'audio', label: 'Audio' },
            { value: 'engine', label: 'Engine' },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {tab === 'chat' && <ChatTab questions={questions} />}
        {tab === 'notes' && <NotesTab notes={notes} onAdd={onAddNote} onDelete={onDeleteNote} />}
        {tab === 'artifacts' && (
          <ArtifactsTab
            key={notebookId || 'default'}
            selectedSources={selectedSources}
            onAddNote={onAddNote}
          />
        )}
        {tab === 'audio' && <AudioTab selectedSources={selectedSources} />}
        {tab === 'engine' && <EngineTab />}
      </div>
    </aside>
  );
}
