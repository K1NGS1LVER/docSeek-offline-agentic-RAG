import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileText, Plus, Trash2, Loader2, FolderOpen } from 'lucide-react';
import { deleteSource, getDocumentViewUrl } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import { Button, Checkbox } from './ui';

function GithubMark({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function SourceRow({ source, checked, onToggle, onDeleted }) {
  const { notebookId } = useParams();
  const { addLog, refreshSources, refreshStats } = useSystem();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 2500);
      return;
    }
    setDeleting(true);
    try {
      await deleteSource(notebookId, source.source_file);
      addLog(`Deleted source ${source.filename}`);
      await refreshSources();
      await refreshStats();
      onDeleted?.(source.source_file);
    } catch (e) {
      addLog(`Delete failed: ${e.message}`, 'ERROR');
      setDeleting(false);
      setConfirming(false);
    }
  };

  const Icon = source.github_repo ? GithubMark : FileText;

  return (
    <div className="group flex items-center gap-3 h-10 px-4 rounded-lg hover:bg-surface-2 transition-colors">
      <Checkbox checked={checked} onChange={onToggle} title="Include in retrieval" />
      <Icon className="w-3.5 h-3.5 text-accent flex-shrink-0" />
      <a
        href={source.first_chunk_id != null ? getDocumentViewUrl(notebookId, source.first_chunk_id) : undefined}
        target="_blank"
        rel="noopener noreferrer"
        title={`${source.filename} — ${source.chunks} chunks (${source.chunking || 'unknown'} chunking)`}
        className="flex-1 min-w-0 truncate text-sm text-text hover:text-accent transition-colors"
      >
        {source.filename}
      </a>
      <span className="font-mono text-2xs text-text-muted group-hover:hidden">
        {source.chunks}
      </span>
      <button
        onClick={handleDelete}
        title={confirming ? 'Click again to delete' : 'Delete source'}
        className={`hidden group-hover:inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
          confirming ? 'text-caution bg-caution-soft' : 'text-text-muted hover:text-caution'
        }`}
      >
        {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

export default function SourcesPanel({ unchecked, setUnchecked, onAdd }) {
  const { sources, ingestStatus } = useSystem();
  const allChecked = unchecked.size === 0;
  const totalChunks = sources.reduce((acc, s) => acc + (s.chunks || 0), 0);

  const toggleAll = () => {
    setUnchecked(allChecked ? new Set(sources.map((s) => s.source_file)) : new Set());
  };

  const toggleOne = (sourceFile) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(sourceFile)) next.delete(sourceFile);
      else next.add(sourceFile);
      return next;
    });
  };

  return (
    <aside className="w-72 flex-shrink-0 bg-surface border-r border-border flex flex-col min-h-0">
      <div className="h-14 flex-shrink-0 flex items-center justify-between pl-6 pr-4 border-b border-border">
        <h2 className="text-base font-semibold text-text">Sources</h2>
        <Button variant="ghost" size="sm" icon={Plus} onClick={onAdd}>
          Add
        </Button>
      </div>

      {sources.length > 0 && (
        <label className="flex items-center gap-3 px-6 py-3 text-sm text-text-muted border-b border-border cursor-pointer">
          <Checkbox checked={allChecked} onChange={toggleAll} />
          Select all sources
        </label>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {sources.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
            <FolderOpen className="w-6 h-6 text-text-muted" />
            <p className="text-sm text-text-dim">
              No sources yet. Add documents and every answer will be grounded in them.
            </p>
            <Button icon={Plus} onClick={onAdd}>
              Add sources
            </Button>
          </div>
        ) : (
          sources.map((s) => (
            <SourceRow
              key={s.source_file}
              source={s}
              checked={!unchecked.has(s.source_file)}
              onToggle={() => toggleOne(s.source_file)}
              onDeleted={(sf) =>
                setUnchecked((prev) => {
                  const next = new Set(prev);
                  next.delete(sf);
                  return next;
                })
              }
            />
          ))
        )}
      </div>

      {ingestStatus?.is_ingesting && (
        <div className="px-6 py-3 border-t border-border space-y-2">
          <div className="flex items-center justify-between font-mono text-2xs text-accent">
            <span className="flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              ingesting
            </span>
            <span className="text-text-muted">
              {ingestStatus.progress}/{ingestStatus.total}
            </span>
          </div>
          <div className="h-1 bg-panel rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: `${ingestStatus.total ? (ingestStatus.progress / ingestStatus.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-t border-border font-mono text-2xs uppercase tracking-[0.1em] text-text-muted">
        <span>{sources.length} source{sources.length !== 1 ? 's' : ''}</span>
        <span>{totalChunks} chunks</span>
      </div>
    </aside>
  );
}
