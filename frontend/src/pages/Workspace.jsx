import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FileText, Plus, StickyNote, BookOpen, Mic, Cpu, HelpCircle } from 'lucide-react';
import { SystemProvider, useSystem } from '../lib/SystemContext';
import { listNotebooks } from '../lib/api';
import WorkspaceHeader from '../components/WorkspaceHeader';
import SourcesPanel from '../components/SourcesPanel';
import ChatPanel from '../components/ChatPanel';
import StudioPanel from '../components/StudioPanel';
import AddSourcesModal from '../components/AddSourcesModal';
import SettingsModal from '../components/SettingsModal';
import PdfViewerModal from '../components/PdfViewerModal';
import CommandPalette from '../components/CommandPalette';

const PANELS_KEY = 'ds_panels';

const DEFAULT_SOURCES_WIDTH = 360;
const MIN_SOURCES_WIDTH = 260;
const MAX_SOURCES_WIDTH = 650;

const DEFAULT_STUDIO_WIDTH = 380;
const MIN_STUDIO_WIDTH = 280;
const MAX_STUDIO_WIDTH = 750;

const MIN_CHAT_WIDTH = 380;
const COLLAPSED_RAIL_WIDTH = 44;

const PANEL_TRANSITION = { duration: 0.2, ease: 'easeInOut' };

function ResizeHandle({ onMouseDown, onDoubleClick, side = 'right' }) {
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation="vertical"
      className={`group absolute top-0 bottom-0 z-30 w-3 flex items-center justify-center cursor-col-resize select-none ${
        side === 'right' ? '-right-1.5' : '-left-1.5'
      }`}
      title="Drag to resize · Double-click to reset width"
    >
      <div className="w-1 h-full rounded-full transition-colors duration-150 group-hover:bg-accent/60 group-active:bg-accent" />
    </div>
  );
}

function CollapsedSourcesRail({ onOpen, onAdd, count }) {
  return (
    <aside className="w-11 h-full bg-surface border-r border-border flex flex-col items-center py-3 gap-3 select-none flex-shrink-0">
      <button
        onClick={onOpen}
        title={`View ${count} sources`}
        className="flex flex-col items-center justify-center gap-1 group py-1 cursor-pointer"
      >
        <FileText className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" />
        <span className="font-mono text-3xs text-text-muted group-hover:text-accent font-semibold px-1 rounded bg-panel border border-border">
          {count}
        </span>
      </button>

      <button
        onClick={onAdd}
        title="Add new sources"
        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-accent hover:bg-surface-2 transition-colors mt-1 cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </aside>
  );
}

function CollapsedStudioRail({ onSelectTab }) {
  return (
    <aside className="w-11 h-full bg-surface border-l border-border flex flex-col items-center py-3 gap-3 select-none flex-shrink-0">
      <button
        onClick={() => onSelectTab('chat')}
        title="Open Prompt Summary"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      <button
        onClick={() => onSelectTab('notes')}
        title="Open Notes"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
      >
        <StickyNote className="w-4 h-4" />
      </button>

      <button
        onClick={() => onSelectTab('artifacts')}
        title="Open Artifacts"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
      >
        <BookOpen className="w-4 h-4" />
      </button>

      <button
        onClick={() => onSelectTab('audio')}
        title="Open Audio Overview"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
      >
        <Mic className="w-4 h-4" />
      </button>

      <button
        onClick={() => onSelectTab('engine')}
        title="Open System Engine"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
      >
        <Cpu className="w-4 h-4" />
      </button>
    </aside>
  );
}

// Notes are scoped per notebook so switching notebooks never mixes their
// saved notes together.
const notesKey = (notebookId) => `ds_notes_${notebookId}`;

function loadNotes(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function loadPanelState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANELS_KEY));
    return {
      sourcesOpen: saved?.sourcesOpen ?? true,
      studioOpen: saved?.studioOpen ?? true,
      sourcesWidth: saved?.sourcesWidth ?? DEFAULT_SOURCES_WIDTH,
      studioWidth: saved?.studioWidth ?? DEFAULT_STUDIO_WIDTH,
    };
  } catch {
    return {
      sourcesOpen: true,
      studioOpen: true,
      sourcesWidth: DEFAULT_SOURCES_WIDTH,
      studioWidth: DEFAULT_STUDIO_WIDTH,
    };
  }
}

function WorkspaceInner({ theme, setTheme, notebookId, notebook, notebooks = [] }) {
  const { stats, sources } = useSystem();

  // Retrieval scope: sources are included by default; unchecked ones are excluded.
  const [unchecked, setUnchecked] = useState(() => new Set());
  const [sourcesOpen, setSourcesOpen] = useState(() => loadPanelState().sourcesOpen);
  const [studioOpen, setStudioOpen] = useState(() => loadPanelState().studioOpen);
  const [studioTab, setStudioTab] = useState('notes');
  const [sourcesWidth, setSourcesWidth] = useState(() => loadPanelState().sourcesWidth);
  const [studioWidth, setStudioWidth] = useState(() => loadPanelState().studioWidth);
  const [isResizingSources, setIsResizingSources] = useState(false);
  const [isResizingStudio, setIsResizingStudio] = useState(false);

  const handleSetLayout = useCallback(
    (preset) => {
      if (preset === 'balanced') {
        setSourcesOpen(true);
        setStudioOpen(true);
        setSourcesWidth(DEFAULT_SOURCES_WIDTH);
        setStudioWidth(DEFAULT_STUDIO_WIDTH);
      } else if (preset === 'research') {
        setSourcesOpen(true);
        setStudioOpen(false);
        setSourcesWidth(Math.min(460, Math.floor(window.innerWidth * 0.35)));
      } else if (preset === 'studio') {
        setSourcesOpen(false);
        setStudioOpen(true);
        setStudioWidth(Math.min(500, Math.floor(window.innerWidth * 0.4)));
      } else if (preset === 'focus') {
        setSourcesOpen(false);
        setStudioOpen(false);
      }
    },
    []
  );

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoOpenedAdd, setAutoOpenedAdd] = useState(false);
  const [notes, setNotes] = useState(() => loadNotes(notesKey(notebookId)));
  const [questions, setQuestions] = useState([]);
  const [activePdf, setActivePdf] = useState(null);

  // Always-current notebookId for the persist effect below, so it can key its
  // localStorage write without listing notebookId as a dependency (which
  // would fire it in the same commit as a notebook switch, before `notes`
  // has been reloaded, clobbering the new notebook's saved notes).
  const notebookIdRef = useRef(notebookId);
  useEffect(() => {
    notebookIdRef.current = notebookId;
  }, [notebookId]);

  // Reload notes whenever the active notebook changes.
  useEffect(() => {
    setNotes(loadNotes(notesKey(notebookId)));
  }, [notebookId]);

  useEffect(() => {
    localStorage.setItem(notesKey(notebookIdRef.current), JSON.stringify(notes));
  }, [notes]);

  useEffect(() => {
    localStorage.setItem(
      PANELS_KEY,
      JSON.stringify({ sourcesOpen, studioOpen, sourcesWidth, studioWidth })
    );
  }, [sourcesOpen, studioOpen, sourcesWidth, studioWidth]);

  // Drag-to-resize handle for SourcesPanel (left dock)
  const handleSourcesMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      setIsResizingSources(true);
      const startX = e.clientX;
      const startWidth = sourcesWidth;
      const currentStudio = studioOpen ? studioWidth : 0;
      const maxAllowed = Math.min(
        MAX_SOURCES_WIDTH,
        Math.max(MIN_SOURCES_WIDTH, window.innerWidth - currentStudio - MIN_CHAT_WIDTH)
      );

      const onMouseMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = Math.min(Math.max(startWidth + delta, MIN_SOURCES_WIDTH), maxAllowed);
        setSourcesWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizingSources(false);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [sourcesWidth, studioOpen, studioWidth]
  );

  // Drag-to-resize handle for StudioPanel (right dock)
  const handleStudioMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      setIsResizingStudio(true);
      const startX = e.clientX;
      const startWidth = studioWidth;
      const currentSources = sourcesOpen ? sourcesWidth : 0;
      const maxAllowed = Math.min(
        MAX_STUDIO_WIDTH,
        Math.max(MIN_STUDIO_WIDTH, window.innerWidth - currentSources - MIN_CHAT_WIDTH)
      );

      const onMouseMove = (moveEvent) => {
        const delta = startX - moveEvent.clientX;
        const newWidth = Math.min(Math.max(startWidth + delta, MIN_STUDIO_WIDTH), maxAllowed);
        setStudioWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizingStudio(false);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [sourcesOpen, sourcesWidth, studioWidth]
  );

  // Smart toggle handlers: when opening a panel while the opposite panel
  // is extra-extended (which minimized the center chat area), reset the extended
  // panel back to default size so the chat area retains comfortable breathing room.
  const toggleSources = useCallback(() => {
    setSourcesOpen((prev) => {
      const willOpen = !prev;
      if (willOpen && studioOpen) {
        if (studioWidth > DEFAULT_STUDIO_WIDTH) {
          setStudioWidth(DEFAULT_STUDIO_WIDTH);
        }
        if (sourcesWidth > DEFAULT_SOURCES_WIDTH) {
          setSourcesWidth(DEFAULT_SOURCES_WIDTH);
        }
      }
      return willOpen;
    });
  }, [studioOpen, studioWidth, sourcesWidth]);

  const toggleStudio = useCallback(() => {
    setStudioOpen((prev) => {
      const willOpen = !prev;
      if (willOpen && sourcesOpen) {
        if (sourcesWidth > DEFAULT_SOURCES_WIDTH) {
          setSourcesWidth(DEFAULT_SOURCES_WIDTH);
        }
        if (studioWidth > DEFAULT_STUDIO_WIDTH) {
          setStudioWidth(DEFAULT_STUDIO_WIDTH);
        }
      }
      return willOpen;
    });
  }, [sourcesOpen, sourcesWidth, studioWidth]);

  // Safety net: when both panels are open, ensure their combined width never
  // compresses the center chat window below MIN_CHAT_WIDTH.
  useEffect(() => {
    if (sourcesOpen && studioOpen) {
      const maxTotal = window.innerWidth - MIN_CHAT_WIDTH;
      if (sourcesWidth + studioWidth > maxTotal) {
        if (sourcesWidth > DEFAULT_SOURCES_WIDTH) setSourcesWidth(DEFAULT_SOURCES_WIDTH);
        if (studioWidth > DEFAULT_STUDIO_WIDTH) setStudioWidth(DEFAULT_STUDIO_WIDTH);
      }
    }
  }, [sourcesOpen, studioOpen, sourcesWidth, studioWidth]);

  // [ / ] toggle the sidebars, Cmd+K opens command palette, ignored while typing anywhere.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }
      const tag = e.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
      if (typing) return;
      if (e.key === '[') toggleSources();
      else if (e.key === ']') toggleStudio();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSources, toggleStudio]);

  // NotebookLM-style onboarding: an empty library opens the add-sources
  // dialog once, so the first action is obvious (state adjusted during
  // render, not in an effect).
  if (stats && sources.length === 0 && stats.total_documents === 0 && !autoOpenedAdd) {
    setAutoOpenedAdd(true);
    setAddOpen(true);
  }

  const selected = sources.filter((s) => !unchecked.has(s.source_file));
  // null = no filter (all sources); a list = scoped retrieval.
  const sourceFilter =
    unchecked.size === 0 ? null : selected.map((s) => s.source_file);

  const addNote = useCallback((note) => {
    const stamp = new Date();
    setNotes((prev) => [
      {
        id: stamp.getTime(),
        title: note.title,
        body: note.body,
        meta: `${note.title && note.body && note.saved !== false ? 'saved' : 'note'} · ${stamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()}`,
      },
      ...prev,
    ]);
  }, []);

  const deleteNote = useCallback((id) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return (
    <div className="h-screen flex flex-col bg-carbon text-text">
      <WorkspaceHeader
        theme={theme}
        setTheme={setTheme}
        notebook={notebook}
        onOpenSettings={() => setSettingsOpen(true)}
        studioOpen={studioOpen}
        onToggleStudio={toggleStudio}
        onSetLayout={handleSetLayout}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden relative">
        <motion.div
          key="sources"
          initial={false}
          animate={{ width: sourcesOpen ? sourcesWidth : COLLAPSED_RAIL_WIDTH }}
          transition={isResizingSources ? { duration: 0 } : PANEL_TRANSITION}
          className="relative flex flex-col h-full min-h-0 overflow-hidden flex-shrink-0"
        >
          {sourcesOpen ? (
            <>
              <SourcesPanel
                unchecked={unchecked}
                setUnchecked={setUnchecked}
                onAdd={() => setAddOpen(true)}
                onClose={() => setSourcesOpen(false)}
                dialogOpen={addOpen}
                onOpenPdf={(filename) => setActivePdf(filename)}
              />
              <ResizeHandle
                onMouseDown={handleSourcesMouseDown}
                onDoubleClick={() => setSourcesWidth(DEFAULT_SOURCES_WIDTH)}
                side="right"
              />
            </>
          ) : (
            <CollapsedSourcesRail
              count={sources.length}
              onOpen={() => setSourcesOpen(true)}
              onAdd={() => setAddOpen(true)}
            />
          )}
        </motion.div>
        <ChatPanel
          sourceFilter={sourceFilter}
          selectedCount={selected.length}
          totalSources={sources.length}
          onSaveNote={addNote}
          onQuestionsChange={setQuestions}
        />
        <motion.div
          key="studio"
          initial={false}
          animate={{ width: studioOpen ? studioWidth : COLLAPSED_RAIL_WIDTH }}
          transition={isResizingStudio ? { duration: 0 } : PANEL_TRANSITION}
          className="relative flex flex-col h-full min-h-0 overflow-hidden flex-shrink-0"
        >
          {studioOpen ? (
            <>
              <ResizeHandle
                onMouseDown={handleStudioMouseDown}
                onDoubleClick={() => setStudioWidth(DEFAULT_STUDIO_WIDTH)}
                side="left"
              />
              <StudioPanel
                notes={notes}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
                selectedSources={selected.map((s) => s.source_file)}
                questions={questions}
                activeTab={studioTab}
                onTabChange={setStudioTab}
              />
            </>
          ) : (
            <CollapsedStudioRail
              onSelectTab={(tab) => {
                setStudioTab(tab);
                setStudioOpen(true);
              }}
            />
          )}
        </motion.div>
      </div>

      {addOpen && <AddSourcesModal onClose={() => setAddOpen(false)} />}
      {settingsOpen && (
        <SettingsModal theme={theme} setTheme={setTheme} onClose={() => setSettingsOpen(false)} />
      )}
      {activePdf && (
        <PdfViewerModal
          notebookId={notebookId}
          filename={activePdf}
          onClose={() => setActivePdf(null)}
        />
      )}

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        theme={theme}
        setTheme={setTheme}
        notebook={notebook}
        notebooks={notebooks}
        onSetLayout={handleSetLayout}
        onOpenSettings={() => setSettingsOpen(true)}
        onAddSource={() => setAddOpen(true)}
      />
    </div>
  );
}

export default function Workspace({ theme, setTheme }) {
  const { notebookId } = useParams();
  const navigate = useNavigate();
  // The notebook record (name/emoji) for the header; null until loaded.
  const [notebook, setNotebook] = useState(null);
  const [notebooks, setNotebooks] = useState([]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotebook(null);

    (async () => {
      try {
        const { data } = await listNotebooks();
        if (cancelled) return;
        setNotebooks(data || []);
        const found = (data || []).find((nb) => nb.id === notebookId);
        if (!found) {
          navigate('/app', { replace: true });
          return;
        }
        setNotebook(found);
      } catch {
        // Non-fatal here: a transient fetch failure just leaves the header's
        // name/emoji blank; the rest of the workspace still works off
        // notebookId directly.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [notebookId, navigate]);

  return (
    <SystemProvider notebookId={notebookId}>
      <WorkspaceInner
        theme={theme}
        setTheme={setTheme}
        notebookId={notebookId}
        notebook={notebook}
        notebooks={notebooks}
      />
    </SystemProvider>
  );
}
