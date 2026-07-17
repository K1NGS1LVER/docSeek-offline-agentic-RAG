import { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { getStats, getIngestStatus, getSources } from '../lib/api';

const SystemContext = createContext(null);

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

  // Initial load + polling. These are async fetchers: state is set in their
  // promise continuations, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStats();
    refreshSources();
    refreshIngestStatus();

    const id = setInterval(() => {
      refreshStats();
      refreshIngestStatus();
    }, 3000);

    return () => clearInterval(id);
  }, [refreshStats, refreshSources, refreshIngestStatus]);

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
  };

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
