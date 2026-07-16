import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Clock,
  Gauge,
  TrendingUp,
  Zap,
  BarChart3,
  ArrowDown,
  ArrowUp,
} from 'lucide-react';
import { useSystem } from '../lib/SystemContext';

/* ── Inline sparkline (simple bar chart) ──────────── */
function Sparkline({ data, height = 32, color = 'var(--color-accent)' }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const barW = Math.max(2, Math.min(6, Math.floor(160 / data.length)));

  return (
    <div className="flex items-end gap-px" style={{ height }}>
      {data.map((v, i) => (
        <div
          key={i}
          className="transition-all duration-200"
          style={{
            width: barW,
            height: `${(v / max) * 100}%`,
            backgroundColor: color,
            opacity: 0.3 + 0.7 * (v / max),
          }}
        />
      ))}
    </div>
  );
}

/* ── Metric card ──────────────────────────────────── */
function MetricCard({ label, value, unit, sub, icon: Icon, trend, sparkData }) {
  return (
    <div className="bg-panel border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3 h-3 text-text-muted" />}
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            {label}
          </span>
        </div>
        {trend != null && (
          <span
            className={`flex items-center gap-0.5 text-[10px] font-mono ${
              trend >= 0 ? 'text-success' : 'text-caution'
            }`}
          >
            {trend >= 0 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-mono font-bold text-text">{value ?? '—'}</span>
        {unit && <span className="text-[10px] font-mono text-text-muted">{unit}</span>}
      </div>
      {sub && <p className="text-[10px] font-mono text-text-muted">{sub}</p>}
      {sparkData && sparkData.length > 1 && <Sparkline data={sparkData} />}
    </div>
  );
}

/* ================================================================== */
export default function Metrics() {
  const { stats, lastLatency, health, logs } = useSystem();
  const [latencyHistory, setLatencyHistory] = useState([]);
  const [prevLatency, setPrevLatency] = useState(null);

  // Track latency history (state adjusted during render, not in an effect).
  if (lastLatency != null && lastLatency !== prevLatency) {
    setPrevLatency(lastLatency);
    setLatencyHistory((prev) => [...prev.slice(-29), lastLatency]);
  }

  // Query/error counts are derived from logs; no state needed.
  const queryCount = logs.filter((l) => l.msg.startsWith('Query:')).length;
  const errorCount = logs.filter((l) => l.level === 'ERROR').length;

  const avgLatency =
    latencyHistory.length > 0
      ? Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length)
      : null;

  const p95Latency =
    latencyHistory.length >= 5
      ? Math.round(
          [...latencyHistory].sort((a, b) => a - b)[Math.floor(latencyHistory.length * 0.95)]
        )
      : null;

  const minLatency =
    latencyHistory.length > 0 ? Math.round(Math.min(...latencyHistory)) : null;
  const maxLatency =
    latencyHistory.length > 0 ? Math.round(Math.max(...latencyHistory)) : null;

  const errorRate =
    queryCount > 0 ? ((errorCount / queryCount) * 100).toFixed(1) : '0.0';

  const vecPerDoc =
    stats?.total_documents && stats?.total_vectors
      ? (stats.total_vectors / stats.total_documents).toFixed(1)
      : null;

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      <div className="flex items-center gap-3">
        <Activity className="w-4 h-4 text-accent" />
        <h1 className="text-sm font-mono font-bold uppercase tracking-wider text-text">
          Performance Metrics
        </h1>
      </div>

      {/* Overview tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border">
        <MetricCard
          icon={Gauge}
          label="Avg Latency"
          value={avgLatency ?? lastLatency ?? '—'}
          unit="ms"
          sub={`${latencyHistory.length} samples`}
          sparkData={latencyHistory}
        />
        <MetricCard
          icon={BarChart3}
          label="Queries (session)"
          value={queryCount}
          sub={`${errorCount} error${errorCount !== 1 ? 's' : ''}`}
        />
        <MetricCard
          icon={Zap}
          label="Error Rate"
          value={errorRate}
          unit="%"
          sub={health === 'READY' ? 'System nominal' : health}
        />
        <MetricCard
          icon={TrendingUp}
          label="Vectors / Doc"
          value={vecPerDoc ?? '—'}
          sub={`${stats?.total_documents ?? 0} docs indexed`}
        />
      </div>

      {/* Latency breakdown */}
      <div className="bg-panel border border-border">
        <div className="h-8 border-b border-border flex items-center px-4 gap-2">
          <Clock className="w-3 h-3 text-text-muted" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Latency Distribution
          </span>
          <span className="text-[10px] font-mono text-text-muted/50 ml-auto">
            {latencyHistory.length} / 30 samples
          </span>
        </div>
        <div className="p-5">
          {latencyHistory.length === 0 ? (
            <p className="text-xs font-mono text-text-muted">
              No latency data yet. Run queries in the Query Engine to collect samples.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Latency bars */}
              <div className="flex items-end gap-px h-20">
                {latencyHistory.map((v, i) => {
                  const max = Math.max(...latencyHistory, 1);
                  return (
                    <motion.div
                      key={i}
                      initial={{ height: 0 }}
                      animate={{ height: `${(v / max) * 100}%` }}
                      transition={{ duration: 0.3 }}
                      className="flex-1 min-w-[3px] bg-accent/50 hover:bg-accent transition-colors cursor-default group relative"
                      title={`${v}ms`}
                    />
                  );
                })}
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: 'Min', value: minLatency, unit: 'ms' },
                  { label: 'Avg', value: avgLatency, unit: 'ms' },
                  { label: 'P95', value: p95Latency, unit: 'ms' },
                  { label: 'Max', value: maxLatency, unit: 'ms' },
                ].map((s) => (
                  <div key={s.label} className="text-center">
                    <p className="text-[10px] font-mono text-text-muted">{s.label}</p>
                    <p className="text-sm font-mono text-text font-bold">
                      {s.value ?? '—'}
                      {s.value != null && (
                        <span className="text-[10px] text-text-muted ml-0.5">{s.unit}</span>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* System load */}
      <div className="bg-panel border border-border">
        <div className="h-8 border-b border-border flex items-center px-4 gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Index Statistics
          </span>
        </div>
        <div className="p-5 grid grid-cols-2 md:grid-cols-3 gap-6">
          {[
            { label: 'Total Documents', value: stats?.total_documents ?? '—' },
            { label: 'Total Vectors', value: stats?.total_vectors ?? '—' },
            { label: 'Avg Chunks/Doc', value: vecPerDoc ?? '—' },
            { label: 'Embedding Model', value: stats?.model ?? '—' },
            { label: 'Dim', value: stats?.embedding_dimension ?? '—' },
            { label: 'Index Type', value: stats?.index_type ?? '—' },
          ].map((row) => (
            <div key={row.label} className="space-y-0.5">
              <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                {row.label}
              </p>
              <p className="text-sm font-mono text-text-dim">{row.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Session log summary */}
      <div className="bg-panel border border-border">
        <div className="h-8 border-b border-border flex items-center px-4 gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Session Activity
          </span>
          <span className="text-[10px] font-mono text-text-muted/50 ml-auto">
            {logs.length} events
          </span>
        </div>
        <div className="p-5">
          <div className="max-h-40 overflow-y-auto space-y-1">
            {logs.slice(-20).reverse().map((log, i) => (
              <div key={i} className="flex items-center gap-3 text-[10px] font-mono">
                <span className="text-text-muted/50 w-16 flex-shrink-0">
                  {new Date(log.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span
                  className={`w-10 flex-shrink-0 ${
                    log.level === 'ERROR' ? 'text-caution' : log.level === 'WARN' ? 'text-accent' : 'text-text-muted'
                  }`}
                >
                  {log.level}
                </span>
                <span className="text-text-muted truncate">{log.msg}</span>
              </div>
            ))}
            {logs.length === 0 && (
              <p className="text-text-muted/50">No session events yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
