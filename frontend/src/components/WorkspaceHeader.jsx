import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sun, Moon, Settings, PanelLeft, PanelRight, ArrowLeft, Network, Layout, Columns3, Maximize2, Search } from 'lucide-react';
import { useSystem } from '../lib/SystemContext';
import { IconButton } from './ui';

const HEALTH_STYLES = {
  READY: { dot: 'bg-success', label: 'ready', text: 'text-text-muted' },
  INDEXING: { dot: 'bg-accent animate-pulse-dot', label: 'indexing', text: 'text-accent' },
  ERROR: { dot: 'bg-caution', label: 'offline', text: 'text-caution' },
  CONNECTING: { dot: 'bg-text-muted animate-pulse-dot', label: 'connecting', text: 'text-text-muted' },
};

function LayoutDropdown({ onSetLayout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <IconButton
        icon={Layout}
        size="md"
        onClick={() => setOpen((v) => !v)}
        title="Workspace layout presets"
        className={open ? 'text-accent bg-surface-2' : ''}
      />
      {open && (
        <div className="absolute right-0 mt-1 w-44 bg-surface border border-border-bright rounded-xl shadow-2xl p-1.5 z-50 text-xs">
          <div className="font-mono text-3xs uppercase tracking-wider text-text-muted px-2 py-1">
            Layout Presets
          </div>
          <button
            onClick={() => {
              onSetLayout('balanced');
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-2 text-text text-left font-sans text-xs transition-colors cursor-pointer"
          >
            <Columns3 className="w-3.5 h-3.5 text-accent" />
            <span>Tri-Pane (Default)</span>
          </button>
          <button
            onClick={() => {
              onSetLayout('research');
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-2 text-text text-left font-sans text-xs transition-colors cursor-pointer"
          >
            <PanelLeft className="w-3.5 h-3.5 text-info" />
            <span>Research Mode</span>
          </button>
          <button
            onClick={() => {
              onSetLayout('studio');
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-2 text-text text-left font-sans text-xs transition-colors cursor-pointer"
          >
            <PanelRight className="w-3.5 h-3.5 text-accent" />
            <span>Studio Mode</span>
          </button>
          <button
            onClick={() => {
              onSetLayout('focus');
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-2 text-text text-left font-sans text-xs transition-colors cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5 text-text-dim" />
            <span>Chat Focus</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default function WorkspaceHeader({
  theme,
  setTheme,
  notebook,
  onOpenSettings,
  studioOpen,
  onToggleStudio,
  onSetLayout,
  onOpenCommandPalette,
}) {
  const { health, stats, lastLatency } = useSystem();
  const h = HEALTH_STYLES[health] || HEALTH_STYLES.CONNECTING;
  const navigate = useNavigate();

  return (
    <header className="h-14 flex-shrink-0 flex items-center gap-4 px-6 bg-surface border-b border-border">
      <Link to="/" className="font-serif font-semibold text-lg tracking-tight text-text">
        doc<span className="text-accent">Seek</span>
      </Link>

      <IconButton icon={ArrowLeft} onClick={() => navigate('/app')} title="All notebooks" />
      <IconButton
        icon={Network}
        onClick={() => navigate(notebook?.id ? `/app/${notebook.id}/graph` : '/graph')}
        title="Knowledge Graph"
      />

      <div className="w-px h-4 bg-border-bright" />

      {notebook && (
        <>
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-base leading-none flex-shrink-0">{notebook.emoji || '📓'}</span>
            <span className="font-serif text-sm font-medium text-text truncate max-w-[240px]">
              {notebook.name}
            </span>
          </span>

          <div className="w-px h-4 bg-border-bright" />
        </>
      )}

      <div className={`flex items-center gap-2 font-mono text-xs ${h.text}`}>
        <span className={`w-2 h-2 rounded-full ${h.dot}`} />
        {h.label}
      </div>

      <span className="font-mono text-xs text-text-muted hidden sm:block">
        {stats ? `${stats.total_documents} chunks · ${stats.total_vectors} vectors` : '—'}
      </span>

      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-surface-2 border border-border text-xs text-text-muted hover:text-text hover:border-border-bright transition-colors font-mono cursor-pointer ml-2"
        title="Open Command Palette (⌘K)"
      >
        <Search className="w-3.5 h-3.5 text-accent" />
        <span>Commands…</span>
        <kbd className="text-3xs px-1 py-0.5 rounded bg-panel border border-border text-text-muted">⌘K</kbd>
      </button>

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
      <LayoutDropdown onSetLayout={onSetLayout} />
      <IconButton
        icon={PanelRight}
        onClick={onToggleStudio}
        title={studioOpen ? 'Hide studio (])' : 'Show studio (])'}
        className={studioOpen ? '' : 'text-accent'}
      />
    </header>
  );
}
