import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileText, Plus, Trash2, Loader2, FolderOpen, RotateCcw, Search, Globe, ExternalLink, ChevronDown, ChevronRight, RefreshCw, Save } from 'lucide-react';
import { deleteSource, getDocumentViewUrl, searchWeb, importWebResults, deepWebResearch, saveResearchReport } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import { Button, Checkbox, IconButton, Segmented } from './ui';

function GithubMark({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function SourceRow({ source, checked, onToggle, onDeleted, onOpenPdf }) {
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

  const isPdf = (source.filename || '').toLowerCase().endsWith('.pdf');
  const Icon = source.github_repo ? GithubMark : FileText;

  return (
    <div className="group flex items-center gap-3 h-10 px-4 rounded-lg hover:bg-surface-2 transition-colors">
      <Checkbox checked={checked} onChange={onToggle} title="Include in retrieval" />
      <Icon className="w-3.5 h-3.5 text-accent flex-shrink-0" />
      {isPdf ? (
        <button
          onClick={() => onOpenPdf?.(source.filename)}
          title={`${source.filename} — ${source.chunks} chunks (Click to view PDF)`}
          className="flex-1 min-w-0 truncate text-left text-sm text-text hover:text-accent transition-colors cursor-pointer"
        >
          {source.filename}
        </button>
      ) : (
        <a
          href={source.first_chunk_id != null ? getDocumentViewUrl(notebookId, source.first_chunk_id) : undefined}
          target="_blank"
          rel="noopener noreferrer"
          title={`${source.filename} — ${source.chunks} chunks (${source.chunking || 'unknown'} chunking)`}
          className="flex-1 min-w-0 truncate text-sm text-text hover:text-accent transition-colors"
        >
          {source.filename}
        </a>
      )}
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

function PendingRow({ item, onRetry, onDismiss }) {
  const failed = item.status === 'error';
  return (
    <div className="group flex items-center gap-3 h-10 px-4 rounded-lg">
      <Checkbox checked={false} disabled onChange={() => {}} title="Not yet ingested" />
      <span className="relative flex items-center justify-center w-3.5 flex-shrink-0">
        <FileText className={`w-3.5 h-3.5 ${failed ? 'text-caution' : 'text-text-muted'}`} />
        <span
          className={`absolute -left-1.5 w-1.5 h-1.5 rounded-full ${
            failed ? 'bg-caution' : 'bg-accent animate-pulse'
          }`}
        />
      </span>
      <span className="flex-1 min-w-0 truncate text-sm text-text-dim">{item.filename}</span>
      {failed ? (
        <span className="flex items-center gap-1 flex-shrink-0">
          <IconButton icon={RotateCcw} onClick={() => onRetry(item.id)} title="Retry" />
          <IconButton icon={Trash2} danger onClick={() => onDismiss(item.id)} title="Dismiss" />
        </span>
      ) : (
        <span className="font-mono text-2xs text-accent flex-shrink-0">
          {item.status === 'ingesting' ? 'ingesting' : 'queued'}
        </span>
      )}
    </div>
  );
}

function WebResearchSection() {
  const { notebookId } = useParams();
  const { researchAvailable, refreshSources, refreshStats, addLog } = useSystem();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('quick');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [traceLog, setTraceLog] = useState([]);
  const [deepReport, setDeepReport] = useState(null);
  const [deepQuery, setDeepQuery] = useState('');
  const [error, setError] = useState(null);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim() || isSearching) return;
    setError(null);
    setResults([]);
    setSelected(new Set());
    setTraceLog([]);
    setDeepReport(null);
    setIsSearching(true);

    try {
      if (mode === 'quick') {
        const { data } = await searchWeb(query.trim(), notebookId);
        setResults(data.results || []);
      } else {
        setDeepQuery(query.trim());
        await deepWebResearch(notebookId, query.trim(), {
          onTrace: (evt) => setTraceLog((prev) => [...prev, evt]),
          onResults: (data) => {
            setResults(data.results || []);
            setDeepReport(data.report_markdown || null);
          },
        });
      }
    } catch (err) {
      setError(err.message);
      addLog(`Web research failed: ${err.message}`, 'ERROR');
    } finally {
      setIsSearching(false);
    }
  };

  const handleImport = async () => {
    if (selected.size === 0 || isImporting) return;
    setIsImporting(true);
    try {
      const urls = [...selected];
      const { data } = await importWebResults(notebookId, urls);
      addLog(`Imported ${data.imported} web source(s)`);
      setSelected(new Set());
      // Remove imported URLs from results
      setResults((prev) => prev.filter((r) => !selected.has(r.url)));
      await refreshSources();
      await refreshStats();
    } catch (err) {
      setError(err.message);
      addLog(`Web import failed: ${err.message}`, 'ERROR');
    } finally {
      setIsImporting(false);
    }
  };

  const handleSaveReport = async () => {
    if (!deepReport) return;
    try {
      await saveResearchReport(notebookId, deepQuery, deepReport);
      addLog('Research report saved to notebook');
      await refreshSources();
      await refreshStats();
    } catch (err) {
      addLog(`Failed to save report: ${err.message}`, 'ERROR');
    }
  };

  const toggleSelect = (url) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (results.length > 0 && selected.size === results.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(results.map((r) => r.url)));
    }
  };

  if (!researchAvailable) {
    return (
      <div className="px-4 py-3 border-b border-border">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full text-left text-sm text-text-muted"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Globe className="w-3.5 h-3.5" />
          Web Research
        </button>
        {expanded && (
          <p className="text-xs text-text-dim mt-2 ml-5">
            Web search unavailable — start SearXNG with{' '}
            <code className="bg-panel px-1 py-0.5 rounded text-2xs">docker compose up -d</code>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left px-4 py-3 text-sm font-medium text-text hover:bg-surface-2 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Globe className="w-3.5 h-3.5 text-accent" />
        Web Research
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3">
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the web…"
              className="flex-1 min-w-0 h-8 px-3 text-sm bg-panel border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent text-text placeholder:text-text-dim"
            />
            <button
              type="submit"
              disabled={isSearching || !query.trim()}
              className="h-8 w-8 flex items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-50"
            >
              {isSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            </button>
          </form>

          <Segmented
            options={[
              { value: 'quick', label: 'Quick' },
              { value: 'deep', label: 'Deep' },
            ]}
            value={mode}
            onChange={setMode}
          />

          {/* Trace log (deep research) */}
          {traceLog.length > 0 && (
            <div className="max-h-24 overflow-y-auto space-y-0.5 text-2xs font-mono text-text-muted bg-panel rounded-lg p-2">
              {traceLog.map((t, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="text-accent flex-shrink-0">›</span>
                  <span className="truncate">{t.detail}</span>
                </div>
              ))}
            </div>
          )}

          {error && (
            <p className="text-xs text-caution bg-caution-soft px-3 py-2 rounded-lg">{error}</p>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1 py-1 border-b border-border/50 text-xs text-text-muted">
                <label className="flex items-center gap-2 cursor-pointer hover:text-text transition-colors">
                  <Checkbox
                    checked={results.length > 0 && selected.size === results.length}
                    onChange={toggleSelectAll}
                  />
                  <span className="font-medium">Select all ({results.length})</span>
                </label>
                {selected.size > 0 && (
                  <span className="text-2xs font-mono text-accent">
                    {selected.size} selected
                  </span>
                )}
              </div>

              <div className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
                {results.map((r) => (
                  <label
                    key={r.url}
                    className="flex items-start gap-2.5 p-2 rounded-lg hover:bg-surface-2 cursor-pointer transition-colors border border-transparent hover:border-border/40"
                  >
                    <Checkbox
                      checked={selected.has(r.url)}
                      onChange={() => toggleSelect(r.url)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-text truncate font-medium">{r.title}</span>
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="flex-shrink-0 text-text-muted hover:text-accent p-0.5"
                          title="Open URL in new tab"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      <p className="text-2xs text-text-dim line-clamp-3 mt-1 leading-relaxed">
                        {r.summary || r.snippet}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          {results.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleImport}
                disabled={selected.size === 0 || isImporting}
              >
                {isImporting ? (
                  <><Loader2 className="w-3 h-3 animate-spin mr-1" />Importing…</>
                ) : (
                  `Import ${selected.size || ''} selected`
                )}
              </Button>
              <IconButton
                icon={RefreshCw}
                onClick={handleSearch}
                title="Retry search"
                disabled={isSearching}
              />
            </div>
          )}

          {/* Deep research report */}
          {deepReport && (
            <div className="space-y-2">
              <div className="max-h-80 overflow-y-auto bg-panel rounded-lg p-3 text-sm text-text prose prose-sm border border-border/50">
                <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed">{deepReport}</pre>
              </div>
              <Button size="sm" icon={Save} onClick={handleSaveReport}>
                Save report to notebook
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SourcesPanel({ unchecked, setUnchecked, onAdd, dialogOpen, onOpenPdf }) {
  const { sources, ingestStatus, uploads, retryUpload, dismissUpload } = useSystem();
  const allChecked = unchecked.size === 0;
  const totalChunks = sources.reduce((acc, s) => acc + (s.chunks || 0), 0);

  const pending = dialogOpen ? [] : uploads.filter((u) => u.status !== 'done');

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

      <WebResearchSection />

      {sources.length > 0 && (
        <label className="flex items-center gap-3 px-6 py-3 text-sm text-text-muted border-b border-border cursor-pointer">
          <Checkbox checked={allChecked} onChange={toggleAll} />
          Select all sources
        </label>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {sources.length === 0 && pending.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-accent-soft border border-accent/20 flex items-center justify-center">
              <FolderOpen className="w-5 h-5 text-accent" />
            </div>
            <div>
              <p className="text-sm font-medium text-text">No sources yet</p>
              <p className="text-xs text-text-dim mt-1">
                Add documents and every answer will be grounded in them.
              </p>
            </div>
            <Button icon={Plus} onClick={onAdd}>
              Add sources
            </Button>
          </div>
        ) : (
          <>
            {pending.map((item) => (
              <PendingRow
                key={item.id}
                item={item}
                onRetry={(id) => retryUpload(id, item.strategy || 'auto')}
                onDismiss={dismissUpload}
              />
            ))}
            {sources.map((s) => (
              <SourceRow
                key={s.source_file}
                source={s}
                checked={!unchecked.has(s.source_file)}
                onToggle={() => toggleOne(s.source_file)}
                onOpenPdf={onOpenPdf}
                onDeleted={(sf) =>
                  setUnchecked((prev) => {
                    const next = new Set(prev);
                    next.delete(sf);
                    return next;
                  })
                }
              />
            ))}
          </>
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
