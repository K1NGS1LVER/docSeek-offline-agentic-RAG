import { useState, useEffect, createContext, useContext, useCallback } from 'react';
import {
  getStats,
  getIngestStatus,
  getSources,
  createPodcast,
  getPodcastStatus,
  getPodcasts,
} from '../lib/api';

const SystemContext = createContext(null);

// The active podcast job_id is persisted so generation survives Studio tab
// switches (and even a page reload) -- the backend runs it in a background
// thread, so the UI just needs to keep polling and re-attach.
const PODCAST_JOB_KEY = 'ds_podcast_job';

// The hook and provider live together by design; splitting files just for
// fast refresh would complicate every import site.
// eslint-disable-next-line react-refresh/only-export-components
export function useSystem() {
  return useContext(SystemContext);
}

export function SystemProvider({ children }) {
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

  const addLog = useCallback((msg, level = 'INFO') => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs((prev) => [...prev.slice(-200), { ts, msg, level }]);
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const { data, latency } = await getStats();
      setStats(data);
      setLastLatency(latency);
      setHealth('READY');
      setError(null);
    } catch (e) {
      setHealth('ERROR');
      setError(e.message);
      addLog(`Stats fetch failed: ${e.message}`, 'ERROR');
    }
  }, [addLog]);

  const refreshSources = useCallback(async () => {
    try {
      const { data } = await getSources();
      setSources(data);
    } catch (e) {
      addLog(`Sources fetch failed: ${e.message}`, 'ERROR');
    }
  }, [addLog]);

  const refreshIngestStatus = useCallback(async () => {
    try {
      const { data } = await getIngestStatus();
      setIngestStatus(data);
      if (data.is_ingesting) {
        setHealth('INDEXING');
      }
    } catch {
      // Server unreachable; keep the last known status.
    }
  }, []);

  const refreshPodcasts = useCallback(async () => {
    try {
      const { data } = await getPodcasts();
      setPodcasts(data);
    } catch {
      // non-fatal: keep the last known list
    }
  }, []);

  // Start a podcast job and begin tracking it (persisted across tab switches).
  const startPodcast = useCallback(async (sourceFiles) => {
    const { data } = await createPodcast(sourceFiles);
    localStorage.setItem(PODCAST_JOB_KEY, data.job_id);
    setPodcastJob({
      job_id: data.job_id, status: 'running', stage: 'queued', message: 'Starting…', progress: 0,
    });
  }, []);

  // Clear a finished/failed job banner.
  const dismissPodcastJob = useCallback(() => {
    localStorage.removeItem(PODCAST_JOB_KEY);
    setPodcastJob(null);
  }, []);

  // Initial load + polling. These are async fetchers: state is set in their
  // promise continuations, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStats();
    refreshSources();
    refreshIngestStatus();
    refreshPodcasts();
    // Re-attach to a podcast job that was still running before this mount.
    const saved = localStorage.getItem(PODCAST_JOB_KEY);
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
  }, [refreshStats, refreshSources, refreshIngestStatus, refreshPodcasts]);

  // Poll the active podcast job until it reaches a terminal state. Runs at the
  // app level, so switching Studio tabs never interrupts it.
  useEffect(() => {
    if (podcastJob?.status !== 'running') return undefined;
    const id = setInterval(async () => {
      try {
        const { data } = await getPodcastStatus(podcastJob.job_id);
        if (data.status === 'completed') {
          localStorage.removeItem(PODCAST_JOB_KEY);
          setPodcastJob(null);
          addLog(`Podcast ready: ${data.title || podcastJob.job_id}`);
          refreshPodcasts();
        } else if (data.status === 'failed') {
          localStorage.removeItem(PODCAST_JOB_KEY);
          setPodcastJob({ ...data, status: 'failed' });
          addLog(`Podcast failed: ${data.error || data.message}`, 'ERROR');
        } else {
          setPodcastJob((prev) => ({ ...prev, ...data }));
        }
      } catch (e) {
        // Job unknown (e.g. server restarted): stop tracking a dead job.
        if (e.message && e.message.includes('Unknown podcast job')) {
          localStorage.removeItem(PODCAST_JOB_KEY);
          setPodcastJob(null);
        }
        // otherwise transient; keep polling
      }
    }, 2000);
    return () => clearInterval(id);
  }, [podcastJob?.status, podcastJob?.job_id, addLog, refreshPodcasts]);

  // Poll faster during ingestion
  useEffect(() => {
    if (!ingestStatus?.is_ingesting) return;
    const id = setInterval(() => {
      refreshIngestStatus();
      refreshSources();
      refreshStats();
    }, 1000);
    return () => clearInterval(id);
  }, [ingestStatus?.is_ingesting, refreshIngestStatus, refreshSources, refreshStats]);

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
  };

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
