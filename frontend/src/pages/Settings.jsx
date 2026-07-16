import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Settings as SettingsIcon,
  RotateCw,
  Trash2,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Shield,
  Database,
  Cpu,
  HardDrive,
} from 'lucide-react';
import { rebuildIndex, resetSystem } from '../lib/api';
import { useSystem } from '../lib/SystemContext';

/* ── Config row ───────────────────────────────────── */
function ConfigRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{label}</span>
      <span className="text-xs font-mono text-text-dim">{value}</span>
    </div>
  );
}

/* ================================================================== */
export default function Settings() {
  const { stats, addLog, refreshStats, refreshDocuments } = useSystem();
  const [rebuilding, setRebuilding] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const handleRebuild = async () => {
    setRebuilding(true);
    setFeedback(null);
    addLog('Rebuild index from Settings');
    try {
      const { latency } = await rebuildIndex();
      setFeedback({ type: 'success', msg: `Index rebuilt in ${latency}ms` });
      addLog(`Rebuilt in ${latency}ms`);
      refreshStats();
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message });
      addLog(`Rebuild failed: ${err.message}`, 'ERROR');
    } finally {
      setRebuilding(false);
    }
  };

  const handleReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setFeedback(null);
    addLog('SYSTEM RESET initiated', 'WARN');
    try {
      const { latency } = await resetSystem();
      setFeedback({ type: 'success', msg: `System reset complete (${latency}ms). All data wiped.` });
      addLog(`System reset complete in ${latency}ms`);
      refreshStats();
      refreshDocuments();
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message });
      addLog(`Reset failed: ${err.message}`, 'ERROR');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      <div className="flex items-center gap-3">
        <SettingsIcon className="w-4 h-4 text-accent" />
        <h1 className="text-sm font-mono font-bold uppercase tracking-wider text-text">
          Settings
        </h1>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-center gap-2 p-3 border text-xs font-mono ${
            feedback.type === 'success'
              ? 'border-success/20 bg-success/5 text-success'
              : 'border-caution/20 bg-caution/5 text-caution'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle className="w-3 h-3" />
          ) : (
            <AlertTriangle className="w-3 h-3" />
          )}
          {feedback.msg}
        </motion.div>
      )}

      {/* System Configuration */}
      <div className="bg-panel border border-border">
        <div className="h-8 border-b border-border flex items-center px-4 gap-2">
          <Cpu className="w-3 h-3 text-text-muted" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            System Configuration
          </span>
        </div>
        <div className="p-5">
          <ConfigRow label="Embedding Model" value={stats?.model ?? '—'} />
          <ConfigRow label="Embedding Dimension" value={stats?.embedding_dimension ?? '—'} />
          <ConfigRow label="Index Type" value={stats?.index_type ?? '—'} />
          <ConfigRow label="Similarity Metric" value="Inner Product (cosine-normalized)" />
          <ConfigRow label="Similarity Threshold" value="0.20" />
          <ConfigRow label="Chunk Size" value="300 characters" />
          <ConfigRow label="Chunk Overlap" value="50 characters" />
          <ConfigRow label="Backend" value="FastAPI + uvicorn:8000" />
          <ConfigRow label="Database" value="SQLite (data/docs.db)" />
          <ConfigRow label="Index Storage" value="data/my_index.faiss" />
        </div>
      </div>

      {/* Current State */}
      <div className="bg-panel border border-border">
        <div className="h-8 border-b border-border flex items-center px-4 gap-2">
          <Database className="w-3 h-3 text-text-muted" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Current State
          </span>
        </div>
        <div className="p-5">
          <ConfigRow label="Total Documents" value={stats?.total_documents ?? 0} />
          <ConfigRow label="Total Vectors" value={stats?.total_vectors ?? 0} />
          <ConfigRow
            label="Est. Index Size"
            value={
              stats?.total_vectors && stats?.embedding_dimension
                ? `${((stats.total_vectors * stats.embedding_dimension * 4) / (1024 * 1024)).toFixed(2)} MB`
                : '—'
            }
          />
        </div>
      </div>

      {/* Index Operations */}
      <div className="bg-panel border border-border">
        <div className="h-8 border-b border-border flex items-center px-4 gap-2">
          <HardDrive className="w-3 h-3 text-text-muted" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Index Operations
          </span>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-xs font-mono text-text-dim">Rebuild FAISS Index</p>
              <p className="text-[10px] font-mono text-text-muted">
                Re-encode all chunks from DB and rebuild the vector index.
              </p>
            </div>
            <button
              onClick={handleRebuild}
              disabled={rebuilding}
              className="flex items-center gap-2 px-4 py-2 bg-accent/10 text-accent text-[11px] font-mono font-bold uppercase tracking-wider hover:bg-accent hover:text-carbon transition-colors disabled:opacity-40"
            >
              {rebuilding ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RotateCw className="w-3 h-3" />
              )}
              {rebuilding ? 'Rebuilding...' : 'Rebuild'}
            </button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-panel border border-caution/20">
        <div className="h-8 border-b border-caution/20 flex items-center px-4 gap-2 bg-caution/5">
          <Shield className="w-3 h-3 text-caution" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-caution">
            Danger Zone
          </span>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-xs font-mono text-caution">Reset Entire System</p>
              <p className="text-[10px] font-mono text-text-muted">
                Permanently deletes ALL documents, vectors, and the FAISS index. This action cannot be undone.
              </p>
            </div>
            <button
              onClick={handleReset}
              disabled={resetting}
              className={`flex items-center gap-2 px-4 py-2 text-[11px] font-mono font-bold uppercase tracking-wider transition-colors disabled:opacity-40 ${
                confirmReset
                  ? 'bg-caution text-carbon'
                  : 'bg-caution/10 text-caution hover:bg-caution hover:text-carbon'
              }`}
            >
              {resetting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Trash2 className="w-3 h-3" />
              )}
              {resetting ? 'Resetting...' : confirmReset ? 'Confirm Reset' : 'Reset System'}
            </button>
          </div>
          {confirmReset && !resetting && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2 text-[10px] font-mono text-caution"
            >
              <AlertTriangle className="w-3 h-3" />
              Click again to confirm. This will wipe all indexed data.
              <button
                onClick={() => setConfirmReset(false)}
                className="ml-auto text-text-muted hover:text-text-dim"
              >
                Cancel
              </button>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
