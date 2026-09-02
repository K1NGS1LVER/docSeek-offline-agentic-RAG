import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileText, Plus, Trash2, Loader2, FolderOpen, RotateCcw, Search, Globe, ExternalLink, ChevronDown, ChevronRight, RefreshCw, Save, Copy, Check, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
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

function WebResearchSection({ onViewSources }) {
  const { notebookId } = useParams();
  const {
    researchAvailable,
    refreshSources,
    refreshStats,
    addLog,
    researchState,
    updateResearchState,
    ingestStatus,
    refreshIngestStatus,
  } = useSystem();

  const {
    query,
    mode,
    results,
    selectedUrls,
    isSearching,
    isImporting,
    traceLog,
    deepReport,
    deepQuery,
    error,
  } = researchState;

  const [lastImportCount, setLastImportCount] = useState(null);

  const handleClear = () => {
    updateResearchState({
      query: '',
      results: [],
      selectedUrls: [],
      traceLog: [],
      deepReport: null,
      deepQuery: '',
      error: null,
    });
    setLastImportCount(null);
  };

  const handleDismissReport = () => {
    updateResearchState({ deepReport: null });
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim() || isSearching) return;
    setLastImportCount(null);
    updateResearchState({
      error: null,
      results: [],
      selectedUrls: [],
      traceLog: [],
      deepReport: null,
      isSearching: true,
    });

    try {
      if (mode === 'quick') {
        const { data } = await searchWeb(query.trim(), notebookId);
        updateResearchState({
          results: data.results || [],
          isSearching: false,
        });
      } else {
        updateResearchState({ deepQuery: query.trim() });
        await deepWebResearch(notebookId, query.trim(), {
          onTrace: (evt) =>
            updateResearchState((prev) => ({ ...prev, traceLog: [...prev.traceLog, evt] })),
          onResults: (data) => {
            updateResearchState({
              results: data.results || [],
              deepReport: data.report_markdown || null,
              isSearching: false,
            });
          },
        });
      }
    } catch (err) {
      updateResearchState({ error: err.message, isSearching: false });
      addLog(`Web research failed: ${err.message}`, 'ERROR');
    }
  };

  const handleImport = async () => {
    if (selectedUrls.length === 0 || isImporting) return;
    updateResearchState({ isImporting: true });
    setLastImportCount(null);
    try {
      const urls = [...selectedUrls];
      refreshIngestStatus();
      const { data } = await importWebResults(notebookId, urls);
      addLog(`Imported ${data.imported} web source(s)`);
      setLastImportCount(data.imported);
      updateResearchState((prev) => ({
        ...prev,
        selectedUrls: [],
        results: prev.results.filter((r) => !urls.includes(r.url)),
        isImporting: false,
      }));
      await refreshSources();
      await refreshStats();
      await refreshIngestStatus();
    } catch (err) {
      updateResearchState({ error: err.message, isImporting: false });
      addLog(`Web import failed: ${err.message}`, 'ERROR');
      await refreshIngestStatus();
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
    updateResearchState((prev) => {
      const exists = prev.selectedUrls.includes(url);
      return {
        ...prev,
        selectedUrls: exists
          ? prev.selectedUrls.filter((u) => u !== url)
          : [...prev.selectedUrls, url],
      };
    });
  };

  const toggleSelectAll = () => {
    updateResearchState((prev) => ({
      ...prev,
      selectedUrls:
        prev.selectedUrls.length === prev.results.length
          ? []
          : prev.results.map((r) => r.url),
    }));
  };

  if (!researchAvailable) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-text-muted space-y-3">
        <Globe className="w-8 h-8 text-text-dim stroke-[1.5]" />
        <div>
          <p className="text-sm font-medium text-text">Web search unavailable</p>
          <p className="text-xs text-text-dim mt-1">
            Start SearXNG locally with:
          </p>
          <code className="inline-block mt-2 bg-panel px-2 py-1 rounded text-2xs text-accent font-mono">
            docker compose up -d
          </code>
        </div>
      </div>
    );
  }

  const computeDeepProgress = () => {
    if (!isSearching || mode !== 'deep' || traceLog.length === 0) return null;
    const last = traceLog[traceLog.length - 1];
    let pct = 15;
    if (last.step === 'search') pct = 25;
    else if (last.step === 'search_done') pct = 45;
    else if (last.step === 'extract') pct = 65;
    else if (last.step === 'summarize') pct = 82;
    else if (last.step === 'report') pct = 94;
    return { pct, detail: last.detail, step: last.step };
  };
  const deepProgress = computeDeepProgress();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-surface">
      {/* Search Input & Controls */}
      <div className="flex-shrink-0 p-3.5 border-b border-border space-y-2.5 bg-surface">
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <input
              type="text"
              value={query}
              onChange={(e) => updateResearchState({ query: e.target.value })}
              placeholder="Search the web…"
              className="w-full h-8 pl-3 pr-7 text-sm bg-panel border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent text-text placeholder:text-text-dim"
            />
            {query && (
              <button
                type="button"
                onClick={() => updateResearchState({ query: '' })}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
                title="Clear input"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={isSearching || !query.trim()}
            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium disabled:opacity-50 hover:bg-accent/90 transition-colors flex-shrink-0"
          >
            {isSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            <span>Search</span>
          </button>
        </form>

        <div className="flex items-center justify-between gap-2">
          <Segmented
            options={[
              { value: 'quick', label: 'Quick' },
              { value: 'deep', label: 'Deep' },
            ]}
            value={mode}
            onChange={(m) => updateResearchState({ mode: m })}
          />

          {(results.length > 0 || deepReport || query) && (
            <button
              type="button"
              onClick={handleClear}
              className="text-2xs text-text-muted hover:text-caution transition-colors flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-2"
              title="Clear all search results and reset"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear results</span>
            </button>
          )}
        </div>

        {/* Trace log (deep research) */}
        {traceLog.length > 0 && (
          <div className="max-h-24 overflow-y-auto space-y-0.5 text-2xs font-mono text-text-muted bg-panel rounded-lg p-2 border border-border/50">
            {traceLog.map((t, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-accent flex-shrink-0">›</span>
                <span className="truncate">{t.detail}</span>
              </div>
            ))}
          </div>
        )}

        {/* Live Ingestion Progress Bar */}
        {(isImporting || ingestStatus?.is_ingesting) && (
          <div className="bg-panel border border-accent/40 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between font-mono text-2xs text-accent">
              <span className="flex items-center gap-2 font-medium">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="truncate max-w-[190px]">
                  {ingestStatus?.message || 'Ingesting web sources...'}
                </span>
              </span>
              <span className="text-text font-semibold flex-shrink-0">
                {ingestStatus?.total ? `${ingestStatus.progress}/${ingestStatus.total}` : 'in progress'}
              </span>
            </div>
            <div className="h-1.5 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{
                  width: `${ingestStatus?.total ? Math.max(6, (ingestStatus.progress / ingestStatus.total) * 100) : 35}%`,
                }}
              />
            </div>
            {ingestStatus?.current_file && (
              <p className="text-2xs text-text-dim truncate font-mono">
                › {ingestStatus.current_file}
              </p>
            )}
          </div>
        )}

        {/* Live Deep Research Progress Bar */}
        {deepProgress && (
          <div className="bg-panel border border-accent/40 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between font-mono text-2xs text-accent">
              <span className="flex items-center gap-2 font-medium">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Deep Research in progress...</span>
              </span>
              <span className="text-text font-semibold flex-shrink-0">
                {deepProgress.pct}%
              </span>
            </div>
            <div className="h-1.5 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${deepProgress.pct}%` }}
              />
            </div>
            <p className="text-2xs text-text-dim truncate font-mono">
              › {deepProgress.detail}
            </p>
          </div>
        )}

        {error && (
          <p className="text-xs text-caution bg-caution-soft px-3 py-2 rounded-lg">{error}</p>
        )}

        {lastImportCount != null && (
          <div className="flex items-center justify-between text-xs text-success bg-success-soft px-3 py-1.5 rounded-lg">
            <span>Imported {lastImportCount} source(s) into notebook!</span>
            {onViewSources && (
              <button
                type="button"
                onClick={onViewSources}
                className="font-medium underline hover:text-success-bright text-2xs ml-2"
              >
                View in Sources →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Scrollable Results & Report Area */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3">
        {results.length === 0 && !deepReport && !isSearching && (
          <div className="flex flex-col items-center justify-center h-48 text-center px-4">
            <Globe className="w-7 h-7 text-text-dim mb-2 opacity-50" />
            <p className="text-xs font-medium text-text-muted">No research results</p>
            <p className="text-2xs text-text-dim mt-1 max-w-[220px]">
              Search query to find sources and import them directly into this notebook.
            </p>
          </div>
        )}

        {/* Results List */}
        {results.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1 text-xs text-text-muted">
              <label className="flex items-center gap-2 cursor-pointer hover:text-text transition-colors">
                <Checkbox
                  checked={results.length > 0 && selectedUrls.length === results.length}
                  onChange={toggleSelectAll}
                />
                <span className="font-medium">Select all ({results.length})</span>
              </label>
              {selectedUrls.length > 0 && (
                <span className="text-2xs font-mono text-accent">
                  {selectedUrls.length} selected
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              {results.map((r) => (
                <label
                  key={r.url}
                  className="flex items-start gap-2.5 p-2.5 rounded-lg bg-panel hover:bg-surface-2 cursor-pointer transition-colors border border-border/50 hover:border-border"
                >
                  <Checkbox
                    checked={selectedUrls.includes(r.url)}
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

        {/* Deep Research Report */}
        {deepReport && (
          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text">Research Report</span>
              <div className="flex items-center gap-1.5">
                <IconButton
                  icon={Copy}
                  onClick={() => {
                    navigator.clipboard.writeText(deepReport);
                    addLog('Report copied to clipboard');
                  }}
                  title="Copy report markdown"
                />
                <Button size="sm" icon={Save} onClick={handleSaveReport}>
                  Save
                </Button>
                <IconButton
                  icon={X}
                  onClick={handleDismissReport}
                  title="Dismiss report"
                />
              </div>
            </div>
            <div className="bg-panel rounded-xl p-3.5 text-xs text-text border border-border/60 prose prose-invert max-w-none leading-relaxed select-text">
              <ReactMarkdown>{deepReport}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>

      {/* Pinned Bottom Action Footer */}
      {results.length > 0 && (
        <div className="flex-shrink-0 p-3 border-t border-border bg-surface flex items-center justify-between gap-2">
          <Button
            size="sm"
            onClick={handleImport}
            disabled={selectedUrls.length === 0 || isImporting || ingestStatus?.is_ingesting}
            className="flex-1"
          >
            {isImporting || ingestStatus?.is_ingesting ? (
              <><Loader2 className="w-3 h-3 animate-spin mr-1.5" />Ingesting {ingestStatus?.total ? `(${ingestStatus.progress}/${ingestStatus.total})` : '…'}</>
            ) : (
              `Import ${selectedUrls.length > 0 ? `${selectedUrls.length} ` : ''}selected`
            )}
          </Button>
          <IconButton
            icon={RefreshCw}
            onClick={handleSearch}
            title="Retry search"
            disabled={isSearching}
          />
          <IconButton
            icon={Trash2}
            onClick={handleClear}
            title="Clear search results"
          />
        </div>
      )}
    </div>
  );
}

export default function SourcesPanel({ unchecked, setUnchecked, onAdd, dialogOpen, onOpenPdf }) {
  const { sources, ingestStatus, uploads, retryUpload, dismissUpload, researchState } = useSystem();
  const [tab, setTab] = useState('sources');

  const allChecked = unchecked.size === 0;
  const totalChunks = sources.reduce((acc, s) => acc + (s.chunks || 0), 0);
  const pending = dialogOpen ? [] : uploads.filter((u) => u.status !== 'done');
  const resultsCount = researchState?.results?.length || 0;

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
    <aside className="w-full h-full flex-shrink-0 bg-surface border-r border-border flex flex-col min-h-0 overflow-hidden select-text">
      {/* Top Segmented Tabs Header */}
      <div className="h-14 flex-shrink-0 flex items-center justify-between px-4 border-b border-border gap-2">
        <div className="flex-1 min-w-0">
          <Segmented
            block
            value={tab}
            onChange={setTab}
            options={[
              { value: 'sources', label: `Sources (${sources.length})` },
              {
                value: 'research',
                label: resultsCount > 0 ? `Research (${resultsCount})` : 'Web Research',
              },
            ]}
          />
        </div>
        {tab === 'sources' && (
          <Button variant="ghost" size="sm" icon={Plus} onClick={onAdd} title="Add sources">
            Add
          </Button>
        )}
      </div>

      {tab === 'sources' ? (
        <>
          {sources.length > 0 && (
            <label className="flex-shrink-0 flex items-center gap-3 px-6 py-2.5 text-sm text-text-muted border-b border-border cursor-pointer hover:bg-surface-2 transition-colors">
              <Checkbox checked={allChecked} onChange={toggleAll} />
              <span>Select all sources</span>
            </label>
          )}

          <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-1">
            {sources.length === 0 && pending.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
                <div className="w-12 h-12 rounded-xl bg-accent-soft border border-accent/20 flex items-center justify-center">
                  <FolderOpen className="w-5 h-5 text-accent" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text">No sources yet</p>
                  <p className="text-xs text-text-dim mt-1">
                    Add documents or research the web to ground all answers.
                  </p>
                </div>
                <div className="flex flex-col gap-2 w-full max-w-[200px] mt-2">
                  <Button icon={Plus} onClick={onAdd} className="w-full">
                    Add sources
                  </Button>
                  <Button variant="outline" icon={Globe} onClick={() => setTab('research')} className="w-full">
                    Research web
                  </Button>
                </div>
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
        </>
      ) : (
        <WebResearchSection onViewSources={() => setTab('sources')} />
      )}

      {ingestStatus?.is_ingesting && (
        <div className="flex-shrink-0 px-4 py-2.5 border-t border-border space-y-1.5 bg-surface">
          <div className="flex items-center justify-between font-mono text-2xs text-accent">
            <span className="flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="truncate max-w-[200px]">{ingestStatus.message || 'ingesting'}</span>
            </span>
            <span className="text-text-muted font-semibold">
              {ingestStatus.progress}/{ingestStatus.total}
            </span>
          </div>
          <div className="h-1 bg-panel rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{
                width: `${ingestStatus.total ? Math.max(5, (ingestStatus.progress / ingestStatus.total) * 100) : 30}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-t border-border font-mono text-2xs uppercase tracking-[0.1em] text-text-muted bg-surface">
        <span>{sources.length} source{sources.length !== 1 ? 's' : ''}</span>
        <span>{totalChunks} chunks</span>
      </div>
    </aside>
  );
}
