import { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import {
  getStats,
  getIngestStatus,
  getSources,
  createPodcast,
  getPodcastStatus,
  getPodcasts,
  uploadFile,
} from '../lib/api';

const SystemContext = createContext(null);

// The active podcast job_id is persisted so generation survives Studio tab
// switches (and even a page reload) -- the backend runs it in a background
// thread, so the UI just needs to keep polling and re-attach. Namespaced per
// notebook so switching notebooks never re-attaches to the wrong job.
const podcastJobKey = (notebookId) => `ds_podcast_job_${notebookId}`;

// The hook and provider live together by design; splitting files just for
// fast refresh would complicate every import site.
// eslint-disable-next-line react-refresh/only-export-components
export function useSystem() {
  return useContext(SystemContext);
}

export function SystemProvider({ notebookId, children }) {
  const [stats, setStats] = useState(null);
  const [ingestStatus, setIngestStatus] = useState(null);
  // Rich per-source rows: {source_file, filename, chunks, first_chunk_id, …}
  const [sources, setSources] = useState([]);
  const [health, setHealth] = useState('CONNECTING');
  const [lastLatency, setLastLatency] = useState(null);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]);
  // Podcast generation lives here (not in a tab component) so it survives tab
  // switches. podcastJob: null | {job_id, status, stage, message, progress, …}.
  const [podcastJob, setPodcastJob] = useState(null);
  const [podcasts, setPodcasts] = useState([]);
  // In-flight file uploads, lifted out of AddSourcesModal so they survive the
  // dialog closing. Each item is tagged with the notebook it targets and is
  // NOT cleared by the notebook-switch reset, so an upload completes into the
  // notebook it was started in.
  const [uploads, setUploads] = useState([]);
  const uploadSeq = useRef(0);
  const pumpingRef = useRef(false);

  const addLog = useCallback((msg, level = 'INFO') => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs((prev) => [...prev.slice(-200), { ts, msg, level }]);
  }, []);

  const refreshStats = useCallback(async () => {
    if (!notebookId) return;
    try {
      const { data, latency } = await getStats(notebookId);
      setStats(data);
      setLastLatency(latency);
      setHealth('READY');
      setError(null);
    } catch (e) {
      setHealth('ERROR');
      setError(e.message);
      addLog(`Stats fetch failed: ${e.message}`, 'ERROR');
    }
  }, [notebookId, addLog]);

  const refreshSources = useCallback(async () => {
    if (!notebookId) return;
    try {
      const { data } = await getSources(notebookId);
      setSources(data);
      // Reconcile: drop a provisional upload once its real source shows up
      // (matched by the filename /upload returned, which equals list_sources'
      // filename). Done here rather than in an effect to avoid set-state-in-effect.
      const present = new Set(data.map((s) => s.filename));
      setUploads((prev) => {
        const next = prev.filter((u) => !(u.status === 'done' && present.has(u.sourceFile)));
        return next.length === prev.length ? prev : next;
      });
    } catch (e) {
      addLog(`Sources fetch failed: ${e.message}`, 'ERROR');
    }
  }, [notebookId, addLog]);

  const refreshIngestStatus = useCallback(async () => {
    if (!notebookId) return;
    try {
      const { data } = await getIngestStatus(notebookId);
      setIngestStatus(data);
      if (data.is_ingesting) {
        setHealth('INDEXING');
      }
    } catch {
      // Server unreachable; keep the last known status.
    }
  }, [notebookId]);

  const refreshPodcasts = useCallback(async () => {
    if (!notebookId) return;
    try {
      const { data } = await getPodcasts(notebookId);
      setPodcasts(data);
    } catch {
      // non-fatal: keep the last known list
    }
  }, [notebookId]);

  // Start a podcast job and begin tracking it (persisted across tab switches).
  const startPodcast = useCallback(async (sourceFiles) => {
    if (!notebookId) return;
    const { data } = await createPodcast(notebookId, sourceFiles);
    localStorage.setItem(podcastJobKey(notebookId), data.job_id);
    setPodcastJob({
      job_id: data.job_id, status: 'running', stage: 'queued', message: 'Starting…', progress: 0,
    });
  }, [notebookId]);

  // Clear a finished/failed job banner.
  const dismissPodcastJob = useCallback(() => {
    if (notebookId) localStorage.removeItem(podcastJobKey(notebookId));
    setPodcastJob(null);
  }, [notebookId]);

  // ── Upload queue ──────────────────────────────────────────────────────
  const updateUpload = useCallback((id, patch) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, []);

  const dismissUpload = useCallback((id) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const enqueueUploads = useCallback((files) => {
    if (!notebookId) return;
    const items = Array.from(files).map((f) => ({
      id: `u${uploadSeq.current++}`,
      notebookId,
      filename: f.name,
      sourceFile: null,
      status: 'queued',
      chunks: null,
      error: null,
      file: f,
      strategy: null,
    }));
    setUploads((prev) => [...prev, ...items]);
  }, [notebookId]);

  // A 4-wide pool that drains 'queued' items. `claimNext` marks the next queued
  // item 'ingesting' inside a functional update, which React applies serially,
  // so concurrent workers never claim the same item (no double upload). Runs in
  // the always-mounted provider, so closing the dialog never interrupts it, and
  // each completion refreshes sources/stats — fixing the "sources don't appear
  // after closing the dialog" bug at its root.
  const startUploads = useCallback(async (strategy) => {
    setUploads((prev) =>
      prev.map((u) => (u.status === 'queued' && u.strategy == null ? { ...u, strategy } : u)));

    if (pumpingRef.current) return;
    pumpingRef.current = true;

    const claimNext = () =>
      new Promise((resolve) => {
        setUploads((prev) => {
          const cand = prev.find((u) => u.status === 'queued');
          resolve(cand || null);
          return cand
            ? prev.map((u) => (u.id === cand.id ? { ...u, status: 'ingesting' } : u))
            : prev;
        });
      });

    const worker = async () => {
      for (;;) {
        const item = await claimNext();
        if (!item) break;
        try {
          const { data } = await uploadFile(
            item.notebookId, item.file, item.strategy === 'auto' ? null : item.strategy,
          );
          updateUpload(item.id, { status: 'done', chunks: data.chunks, sourceFile: data.filename });
          addLog(`Indexed ${item.filename}: ${data.chunks} chunks in ${data.time_seconds}s`);
          refreshSources();
          refreshStats();
        } catch (e) {
          updateUpload(item.id, { status: 'error', error: e.message });
          addLog(`Failed ${item.filename}: ${e.message}`, 'ERROR');
        }
      }
    };

    await Promise.all(Array.from({ length: 4 }, worker));
    pumpingRef.current = false;
  }, [updateUpload, addLog, refreshSources, refreshStats]);

  const retryUpload = useCallback((id, strategy) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'queued', error: null } : u)));
    startUploads(strategy);
  }, [startUploads]);

  // Initial load + polling. These are async fetchers: state is set in their
  // promise continuations, not synchronously in the effect body. Re-runs
  // whenever the active notebook changes, resetting per-notebook state first
  // so stale data from the previous notebook never lingers on screen.
  useEffect(() => {
    if (!notebookId) return undefined;

    setStats(null);
    setSources([]);
    setIngestStatus(null);
    setPodcasts([]);
    setPodcastJob(null);
    setLastLatency(null);
    setError(null);

    refreshStats();
    refreshSources();
    refreshIngestStatus();
    refreshPodcasts();
    // Re-attach to a podcast job that was still running before this mount.
    const saved = localStorage.getItem(podcastJobKey(notebookId));
    if (saved) {
      setPodcastJob({
        job_id: saved, status: 'running', stage: 'resuming',
        message: 'Reconnecting to your episode…', progress: 0,
      });
    }

    const id = setInterval(() => {
      refreshStats();
      refreshIngestStatus();
    }, 3000);

    return () => clearInterval(id);
  }, [notebookId, refreshStats, refreshSources, refreshIngestStatus, refreshPodcasts]);

  // Poll the active podcast job until it reaches a terminal state. Runs at the
  // app level, so switching Studio tabs never interrupts it.
  useEffect(() => {
    if (!notebookId || podcastJob?.status !== 'running') return undefined;
    const id = setInterval(async () => {
      try {
        const { data } = await getPodcastStatus(notebookId, podcastJob.job_id);
        if (data.status === 'completed') {
          localStorage.removeItem(podcastJobKey(notebookId));
          setPodcastJob(null);
          addLog(`Podcast ready: ${data.title || podcastJob.job_id}`);
          refreshPodcasts();
        } else if (data.status === 'failed') {
          localStorage.removeItem(podcastJobKey(notebookId));
          setPodcastJob({ ...data, status: 'failed' });
          addLog(`Podcast failed: ${data.error || data.message}`, 'ERROR');
        } else {
          setPodcastJob((prev) => ({ ...prev, ...data }));
        }
      } catch (e) {
        // Job unknown (e.g. server restarted): stop tracking a dead job.
        if (e.message && e.message.includes('Unknown podcast job')) {
          localStorage.removeItem(podcastJobKey(notebookId));
          setPodcastJob(null);
        }
        // otherwise transient; keep polling
      }
    }, 2000);
    return () => clearInterval(id);
  }, [notebookId, podcastJob?.status, podcastJob?.job_id, addLog, refreshPodcasts]);

  // Poll faster during ingestion
  useEffect(() => {
    if (!notebookId || !ingestStatus?.is_ingesting) return;
    const id = setInterval(() => {
      refreshIngestStatus();
      refreshSources();
      refreshStats();
    }, 1000);
    return () => clearInterval(id);
  }, [notebookId, ingestStatus?.is_ingesting, refreshIngestStatus, refreshSources, refreshStats]);

  // Poll sources while file uploads are in flight. File uploads never set the
  // `is_ingesting` flag (that's GitHub-only), so without this the sidebar would
  // never refresh after the dialog closes even though the header (stats, which
  // IS polled) updates — the reported bug. Keeps sources converging and lets
  // finished files appear in the sidebar one-by-one.
  const hasActiveUploads = uploads.some(
    (u) => u.notebookId === notebookId && (u.status === 'queued' || u.status === 'ingesting'),
  );
  useEffect(() => {
    if (!notebookId || !hasActiveUploads) return undefined;
    const id = setInterval(() => {
      refreshSources();
      refreshStats();
    }, 1000);
    return () => clearInterval(id);
  }, [notebookId, hasActiveUploads, refreshSources, refreshStats]);

  const value = {
    stats,
    ingestStatus,
    sources,
    health,
    lastLatency,
    error,
    logs,
    addLog,
    refreshStats,
    refreshSources,
    refreshIngestStatus,
    podcastJob,
    podcasts,
    startPodcast,
    dismissPodcastJob,
    refreshPodcasts,
    uploads: uploads.filter((u) => u.notebookId === notebookId),
    enqueueUploads,
    startUploads,
    retryUpload,
    dismissUpload,
  };

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
