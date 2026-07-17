import { useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { useSystem } from '../lib/SystemContext';
import { Button, SectionLabel, Segmented, inputCls, textareaCls } from './ui';

function NoteCard({ note, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="group bg-panel border border-border rounded-xl p-4 cursor-pointer hover:border-border-bright transition-colors"
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
        <p className="text-sm text-text-muted text-center px-4 py-8">
          Notes live here — save an answer from the chat or write your own.
        </p>
      )}
      {notes.map((n) => (
        <NoteCard key={n.id} note={n} onDelete={onDelete} />
      ))}
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

  // Track latency samples (state adjusted during render, not in an effect).
  if (lastLatency != null && lastLatency !== prevLatency) {
    setPrevLatency(lastLatency);
    setLatencyHistory((prev) => [...prev.slice(-29), lastLatency]);
  }

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

export default function StudioPanel({ notes, onAddNote, onDeleteNote }) {
  const [tab, setTab] = useState('notes');

  return (
    <aside className="w-80 flex-shrink-0 bg-surface border-l border-border flex flex-col min-h-0">
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <Segmented
          block
          value={tab}
          onChange={setTab}
          options={[
            { value: 'notes', label: 'Notes' },
            { value: 'engine', label: 'Engine' },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {tab === 'notes' ? (
          <NotesTab notes={notes} onAdd={onAddNote} onDelete={onDeleteNote} />
        ) : (
          <EngineTab />
        )}
      </div>
    </aside>
  );
}
