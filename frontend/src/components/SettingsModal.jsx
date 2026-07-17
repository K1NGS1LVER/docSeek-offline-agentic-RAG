import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  RotateCw,
  Trash2,
  AlertTriangle,
  CheckCircle,
  Terminal,
  Play,
  ChevronDown,
} from 'lucide-react';
import { rebuildIndex, resetSystem } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import { Modal, Button, Segmented, OpRow, textareaCls } from './ui';

const DEBUG_ENDPOINTS = [
  { method: 'GET', path: '/stats', label: 'System stats' },
  { method: 'GET', path: '/sources', label: 'List sources' },
  { method: 'GET', path: '/ingest/status', label: 'Ingest status' },
  { method: 'POST', path: '/search', label: 'Search', body: '{"query":"test","k":3}' },
  { method: 'POST', path: '/ingest', label: 'Ingest text', body: '{"text":"sample text","metadata":"{\\"filename\\":\\"debug.txt\\",\\"source_file\\":\\"debug.txt\\"}"}' },
  { method: 'POST', path: '/rebuild', label: 'Rebuild index' },
];

/* ── Compact API console ── */
function DebugConsole({ addLog }) {
  const [selected, setSelected] = useState(0);
  const [bodyText, setBodyText] = useState('');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const ep = DEBUG_ENDPOINTS[selected];

  const select = (i) => {
    setSelected(i);
    setBodyText(DEBUG_ENDPOINTS[i].body || '');
    setResponse(null);
  };

  const send = async () => {
    setLoading(true);
    setResponse(null);
    addLog(`DEBUG ${ep.method} ${ep.path}`);
    const start = performance.now();
    try {
      const opts = { method: ep.method, headers: {} };
      if (ep.body && bodyText.trim()) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = bodyText;
      }
      const res = await fetch(`/api${ep.path}`, opts);
      const elapsed = Math.round(performance.now() - start);
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      setResponse({ status: res.status, latency: elapsed, data, ok: res.ok });
    } catch (err) {
      setResponse({ status: 0, latency: Math.round(performance.now() - start), data: err.message, ok: false });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2 pt-2">
      <div className="flex flex-wrap gap-2">
        {DEBUG_ENDPOINTS.map((e, i) => (
          <button
            key={i}
            onClick={() => select(i)}
            className={`font-mono text-xs h-7 px-3 rounded-full border transition-colors ${
              selected === i
                ? 'border-accent text-accent bg-accent-soft'
                : 'border-border text-text-muted hover:text-text-dim hover:border-border-bright'
            }`}
          >
            <b className={e.method === 'GET' ? 'text-success' : 'text-info'}>{e.method}</b> {e.path}
          </button>
        ))}
      </div>
      {ep.body !== undefined && (
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          rows={3}
          spellCheck={false}
          className={`${textareaCls} font-mono text-xs`}
        />
      )}
      <Button size="sm" onClick={send} disabled={loading} busy={loading} icon={Play}>
        Send
      </Button>
      {response && (
        <div className="bg-panel border border-border rounded-lg overflow-hidden">
          <div className="flex items-center gap-4 px-4 py-2 border-b border-border font-mono text-xs">
            <span className={response.ok ? 'text-success' : 'text-caution'}>{response.status}</span>
            <span className="text-text-muted">{response.latency}ms</span>
          </div>
          <pre className="p-4 font-mono text-xs text-text-dim overflow-x-auto max-h-64 overflow-y-auto">
            {typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
export default function SettingsModal({ theme, setTheme, onClose }) {
  const { addLog, refreshStats, refreshSources } = useSystem();
  const [rebuilding, setRebuilding] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [consoleOpen, setConsoleOpen] = useState(false);

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
      refreshSources();
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message });
      addLog(`Reset failed: ${err.message}`, 'ERROR');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      {feedback && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-center gap-2 px-4 py-3 border rounded-xl text-xs ${
            feedback.type === 'success'
              ? 'border-success/25 bg-success-soft text-success'
              : 'border-caution/25 bg-caution-soft text-caution'
          }`}
        >
          {feedback.type === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          {feedback.msg}
        </motion.div>
      )}

      <OpRow title="Theme" sub="Cream by default; dark for late nights.">
        <Segmented
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', label: 'Cream' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </OpRow>

      <OpRow
        title="Rebuild index"
        sub="Re-embed every chunk from SQLite and recreate the FAISS index."
      >
        <Button
          variant="ghost"
          icon={RotateCw}
          busy={rebuilding}
          onClick={handleRebuild}
          disabled={rebuilding}
          className="flex-shrink-0"
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild'}
        </Button>
      </OpRow>

      <div className="border border-border bg-panel rounded-xl overflow-hidden">
        <button
          onClick={() => setConsoleOpen(!consoleOpen)}
          className="w-full flex items-center justify-between gap-6 px-6 py-4 text-left"
        >
          <span className="flex items-center gap-4">
            <Terminal className="w-4 h-4 text-text-muted" />
            <span>
              <h4 className="text-sm font-semibold text-text">Debug console</h4>
              <p className="text-xs text-text-dim mt-0.5">Raw API requests against the engine.</p>
            </span>
          </span>
          <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${consoleOpen ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence>
          {consoleOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="px-6 pb-6">
                <DebugConsole addLog={addLog} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <OpRow
        danger
        title="Reset system"
        sub="Deletes all documents, vectors, and the index. Cannot be undone."
      >
        <div className="flex items-center gap-2 flex-shrink-0">
          {confirmReset && !resetting && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
          )}
          <Button
            variant={confirmReset ? 'dangerSolid' : 'danger'}
            icon={Trash2}
            busy={resetting}
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting ? 'Resetting…' : confirmReset ? 'Click again to confirm' : 'Reset…'}
          </Button>
        </div>
      </OpRow>
    </Modal>
  );
}
