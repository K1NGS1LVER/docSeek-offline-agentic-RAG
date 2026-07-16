import { useState } from 'react';
import {
  Bug,
  Play,
  Loader2,
  Copy,
  Check,
  Terminal,
} from 'lucide-react';
import { useSystem } from '../lib/SystemContext';

const BASE = '/api';

const ENDPOINTS = [
  { method: 'GET',    path: '/stats',         label: 'System Stats',       body: false },
  { method: 'GET',    path: '/documents',     label: 'List Documents',     body: false },
  { method: 'GET',    path: '/ingest/status', label: 'Ingest Status',      body: false },
  { method: 'POST',   path: '/search',        label: 'Search',             body: true,  default: '{"query":"test","k":3}' },
  { method: 'POST',   path: '/ingest',        label: 'Ingest Text',        body: true,  default: '{"text":"sample text","metadata":{"source":"debug"}}' },
  { method: 'POST',   path: '/ingest/github', label: 'GitHub Ingest',      body: true,  default: '{"repo_url":"https://github.com/user/repo","subpath":"docs"}' },
  { method: 'POST',   path: '/rebuild',       label: 'Rebuild Index',      body: false },
  { method: 'DELETE', path: '/reset',         label: 'Reset System',       body: false },
];

/* ================================================================== */
export default function Debug() {
  const { logs, addLog } = useSystem();
  const [selected, setSelected] = useState(0);
  const [bodyText, setBodyText] = useState(ENDPOINTS[0].default || '');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const ep = ENDPOINTS[selected];

  const handleSelect = (idx) => {
    setSelected(idx);
    setBodyText(ENDPOINTS[idx].default || '');
    setResponse(null);
  };

  const handleSend = async () => {
    setLoading(true);
    setResponse(null);
    const url = `${BASE}${ep.path}`;
    addLog(`DEBUG ${ep.method} ${ep.path}`);

    const start = performance.now();
    try {
      const opts = { method: ep.method, headers: {} };
      if (ep.body && bodyText.trim()) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = bodyText;
      }
      const res = await fetch(url, opts);
      const elapsed = Math.round(performance.now() - start);
      let data;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }
      setResponse({ status: res.status, latency: elapsed, data, ok: res.ok });
      addLog(`DEBUG ${res.status} ${elapsed}ms`);
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      setResponse({ status: 0, latency: elapsed, data: err.message, ok: false });
      addLog(`DEBUG error: ${err.message}`, 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!response) return;
    navigator.clipboard.writeText(
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2)
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-10 border-b border-border flex items-center px-4 gap-3 flex-shrink-0 bg-panel">
        <Bug className="w-4 h-4 text-accent" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
          Debug Console
        </span>
        <span className="text-[10px] font-mono text-text-muted/50 ml-auto">
          {ENDPOINTS.length} endpoints
        </span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Endpoint list */}
        <div className="w-56 border-r border-border bg-panel overflow-y-auto flex-shrink-0">
          {ENDPOINTS.map((e, i) => (
            <button
              key={i}
              onClick={() => handleSelect(i)}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-2 border-b border-border transition-colors ${
                selected === i
                  ? 'bg-accent/5 border-l-2 border-l-accent'
                  : 'hover:bg-surface border-l-2 border-l-transparent'
              }`}
            >
              <span
                className={`text-[10px] font-mono font-bold w-10 flex-shrink-0 ${
                  e.method === 'GET'
                    ? 'text-success'
                    : e.method === 'POST'
                    ? 'text-info'
                    : 'text-caution'
                }`}
              >
                {e.method}
              </span>
              <span className="text-[11px] font-mono text-text-dim truncate">{e.label}</span>
            </button>
          ))}
        </div>

        {/* Request / Response */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Request bar */}
          <div className="h-10 border-b border-border flex items-center px-4 gap-3 flex-shrink-0">
            <span
              className={`text-[10px] font-mono font-bold ${
                ep.method === 'GET'
                  ? 'text-success'
                  : ep.method === 'POST'
                  ? 'text-info'
                  : 'text-caution'
              }`}
            >
              {ep.method}
            </span>
            <span className="text-xs font-mono text-text-dim">{BASE}{ep.path}</span>
            <div className="flex-1" />
            <button
              onClick={handleSend}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1 bg-accent/10 text-accent text-[10px] font-mono font-bold uppercase tracking-wider hover:bg-accent hover:text-carbon transition-colors disabled:opacity-40"
            >
              {loading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Play className="w-3 h-3" />
              )}
              Send
            </button>
          </div>

          {/* Body editor (if POST) */}
          {ep.body && (
            <div className="border-b border-border flex-shrink-0">
              <div className="h-6 border-b border-border flex items-center px-4">
                <span className="text-[10px] font-mono text-text-muted uppercase">Request Body (JSON)</span>
              </div>
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={4}
                className="w-full bg-carbon text-xs font-mono text-text-dim p-4 focus:outline-none resize-none"
                spellCheck={false}
              />
            </div>
          )}

          {/* Response */}
          <div className="flex-1 overflow-y-auto">
            {response && (
              <div className="p-0">
                <div className="h-8 border-b border-border flex items-center px-4 gap-3 bg-panel">
                  <span
                    className={`text-[10px] font-mono font-bold ${
                      response.ok ? 'text-success' : 'text-caution'
                    }`}
                  >
                    {response.status}
                  </span>
                  <span className="text-[10px] font-mono text-text-muted">
                    {response.latency}ms
                  </span>
                  <div className="flex-1" />
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 text-[10px] font-mono text-text-muted hover:text-accent transition-colors"
                  >
                    {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="p-4 text-xs font-mono text-text-dim overflow-x-auto">
                  {typeof response.data === 'string'
                    ? response.data
                    : JSON.stringify(response.data, null, 2)}
                </pre>
              </div>
            )}

            {!response && !loading && (
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-2">
                  <Terminal className="w-6 h-6 text-border-bright mx-auto" />
                  <p className="text-[10px] font-mono text-text-muted">
                    Select an endpoint and hit Send
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom log strip */}
      <div className="h-24 border-t border-border bg-panel overflow-y-auto flex-shrink-0">
        <div className="h-6 border-b border-border flex items-center px-4 sticky top-0 bg-panel z-10">
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Debug Log
          </span>
          <span className="text-[10px] font-mono text-text-muted/50 ml-auto">
            {logs.length} entries
          </span>
        </div>
        <div className="px-4 py-1 space-y-0.5">
          {logs.slice(-15).reverse().map((log, i) => (
            <div key={i} className="flex gap-3 text-[10px] font-mono">
              <span className="text-text-muted/40 w-16 flex-shrink-0">
                {new Date(log.ts).toLocaleTimeString('en-US', { hour12: false })}
              </span>
              <span
                className={
                  log.level === 'ERROR' ? 'text-caution' : 'text-text-muted'
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
