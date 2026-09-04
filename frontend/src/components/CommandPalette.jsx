import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  BookOpen,
  Network,
  Settings,
  Moon,
  Sun,
  Sparkles,
  FileText,
  Compass,
  Plus,
  Columns3,
  Maximize2,
  X,
  ArrowRight,
} from 'lucide-react';

function CommandPaletteModal({
  onClose,
  theme,
  setTheme,
  notebook,
  notebooks = [],
  onSetLayout,
  onOpenSettings,
  onAddSource,
  onSetMode,
}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands = useMemo(() => {
    const list = [
      // Navigation
      {
        id: 'nav-notebooks',
        title: 'All Notebooks',
        category: 'Navigation',
        icon: BookOpen,
        action: () => navigate('/app'),
      },
      {
        id: 'nav-graph',
        title: 'Knowledge Graph',
        category: 'Navigation',
        icon: Network,
        action: () => navigate(notebook?.id ? `/app/${notebook.id}/graph` : '/graph'),
      },
      {
        id: 'nav-settings',
        title: 'System Settings',
        category: 'Navigation',
        icon: Settings,
        action: () => onOpenSettings?.(),
      },
      // Query Modes
      {
        id: 'mode-ask',
        title: 'Mode: Ask Grounded Q&A',
        category: 'Query Mode',
        icon: Sparkles,
        action: () => onSetMode?.('ask'),
      },
      {
        id: 'mode-search',
        title: 'Mode: Search Raw Chunks',
        category: 'Query Mode',
        icon: FileText,
        action: () => onSetMode?.('search'),
      },
      {
        id: 'mode-research',
        title: 'Mode: Deep Dive Research',
        category: 'Query Mode',
        icon: Compass,
        action: () => onSetMode?.('research'),
      },
      // Layout Presets
      {
        id: 'layout-balanced',
        title: 'Layout: Tri-Pane Balanced',
        category: 'Layout',
        icon: Columns3,
        action: () => onSetLayout?.('balanced'),
      },
      {
        id: 'layout-research',
        title: 'Layout: Research Focus',
        category: 'Layout',
        icon: FileText,
        action: () => onSetLayout?.('research'),
      },
      {
        id: 'layout-studio',
        title: 'Layout: Studio Focus',
        category: 'Layout',
        icon: BookOpen,
        action: () => onSetLayout?.('studio'),
      },
      {
        id: 'layout-chat',
        title: 'Layout: Chat Full Focus',
        category: 'Layout',
        icon: Maximize2,
        action: () => onSetLayout?.('focus'),
      },
      // Theme & Actions
      {
        id: 'action-theme',
        title: theme === 'light' ? 'Switch to Dark Carbon Theme' : 'Switch to Light Cream Theme',
        category: 'Theme',
        icon: theme === 'light' ? Moon : Sun,
        action: () => setTheme?.(theme === 'light' ? 'dark' : 'light'),
      },
      {
        id: 'action-add-source',
        title: 'Add New Sources to Notebook',
        category: 'Actions',
        icon: Plus,
        action: () => onAddSource?.(),
      },
    ];

    // Add quick notebook jumps
    if (notebooks.length > 0) {
      notebooks.forEach((nb) => {
        if (nb.id !== notebook?.id) {
          list.push({
            id: `nb-${nb.id}`,
            title: `Jump to Notebook: ${nb.name}`,
            category: 'Notebooks',
            icon: BookOpen,
            action: () => navigate(`/app/${nb.id}`),
          });
        }
      });
    }

    if (!query.trim()) return list;

    const q = query.toLowerCase().trim();
    return list.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
    );
  }, [navigate, notebook, notebooks, onAddSource, onOpenSettings, onSetLayout, onSetMode, query, setTheme, theme]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % (commands.length || 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + (commands.length || 1)) % (commands.length || 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (commands[selectedIndex]) {
        commands[selectedIndex].action();
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[15vh] p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-xl bg-surface border border-border-bright rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 px-4 h-13 border-b border-border bg-panel">
          <Search className="w-4 h-4 text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or jump to..."
            className="flex-1 min-w-0 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none font-sans"
          />
          <kbd className="font-mono text-3xs px-1.5 py-0.5 rounded bg-surface border border-border text-text-muted select-none">
            ESC
          </kbd>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text p-1 rounded-md transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Command Items List */}
        <div className="max-h-[360px] overflow-y-auto p-2 space-y-1">
          {commands.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-dim font-mono">
              No matching commands
            </div>
          ) : (
            commands.map((cmd, idx) => {
              const Icon = cmd.icon;
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => {
                    cmd.action();
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-accent text-on-accent font-medium'
                      : 'text-text hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Icon
                      className={`w-4 h-4 flex-shrink-0 ${
                        isSelected ? 'text-on-accent' : 'text-text-muted'
                      }`}
                    />
                    <span className="text-xs truncate">{cmd.title}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className={`font-mono text-3xs uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        isSelected
                          ? 'bg-black/20 text-on-accent'
                          : 'bg-panel border border-border text-text-muted'
                      }`}
                    >
                      {cmd.category}
                    </span>
                    {isSelected && <ArrowRight className="w-3.5 h-3.5 text-on-accent" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Command Palette Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-panel font-mono text-3xs text-text-muted select-none">
          <span>Navigate with ↑ ↓ · Select with ↵</span>
          <span>docSeek Quick Command</span>
        </div>
      </div>
    </div>
  );
}

export default function CommandPalette({ isOpen, ...props }) {
  if (!isOpen) return null;
  return <CommandPaletteModal {...props} />;
}
