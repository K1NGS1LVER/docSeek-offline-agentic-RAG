import { Link } from 'react-router-dom';
import { Sun, Moon, Settings, PanelLeft, PanelRight } from 'lucide-react';
import { useSystem } from '../lib/SystemContext';
import { IconButton } from './ui';

const HEALTH_STYLES = {
  READY: { dot: 'bg-success', label: 'ready', text: 'text-text-muted' },
  INDEXING: { dot: 'bg-accent animate-pulse-dot', label: 'indexing', text: 'text-accent' },
  ERROR: { dot: 'bg-caution', label: 'offline', text: 'text-caution' },
  CONNECTING: { dot: 'bg-text-muted animate-pulse-dot', label: 'connecting', text: 'text-text-muted' },
};

export default function WorkspaceHeader({
  theme,
  setTheme,
  onOpenSettings,
  sourcesOpen,
  studioOpen,
  onToggleSources,
  onToggleStudio,
}) {
  const { health, stats, lastLatency } = useSystem();
  const h = HEALTH_STYLES[health] || HEALTH_STYLES.CONNECTING;

  return (
    <header className="h-14 flex-shrink-0 flex items-center gap-4 px-6 bg-surface border-b border-border">
      <IconButton
        icon={PanelLeft}
        onClick={onToggleSources}
        title={sourcesOpen ? 'Hide sources ([)' : 'Show sources ([)'}
        className={sourcesOpen ? '' : 'text-accent'}
      />
      <Link to="/" className="font-serif font-semibold text-lg tracking-tight text-text">
        doc<span className="text-accent">Seek</span>
      </Link>

      <div className="w-px h-4 bg-border-bright" />

      <div className={`flex items-center gap-2 font-mono text-xs ${h.text}`}>
        <span className={`w-2 h-2 rounded-full ${h.dot}`} />
        {h.label}
      </div>

      <span className="font-mono text-xs text-text-muted hidden sm:block">
        {stats ? `${stats.total_documents} chunks · ${stats.total_vectors} vectors` : '—'}
      </span>

      <div className="flex-1" />

      <span className="font-mono text-xs text-text-muted hidden md:block">
        {lastLatency != null ? `${lastLatency}ms` : ''}
      </span>

      <IconButton
        size="md"
        icon={theme === 'light' ? Moon : Sun}
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        title={theme === 'light' ? 'Switch to dark' : 'Switch to cream'}
      />
      <IconButton size="md" icon={Settings} onClick={onOpenSettings} title="Settings" />
      <IconButton
        icon={PanelRight}
        onClick={onToggleStudio}
        title={studioOpen ? 'Hide studio (])' : 'Show studio (])'}
        className={studioOpen ? '' : 'text-accent'}
      />
    </header>
  );
}
