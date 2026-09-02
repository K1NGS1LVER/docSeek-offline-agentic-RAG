import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { SystemProvider, useSystem } from '../lib/SystemContext';
import { listNotebooks } from '../lib/api';
import WorkspaceHeader from '../components/WorkspaceHeader';
import SourcesPanel from '../components/SourcesPanel';
import ChatPanel from '../components/ChatPanel';
import StudioPanel from '../components/StudioPanel';
import AddSourcesModal from '../components/AddSourcesModal';
import SettingsModal from '../components/SettingsModal';
import PdfViewerModal from '../components/PdfViewerModal';

const PANELS_KEY = 'ds_panels';

const DEFAULT_SOURCES_WIDTH = 360;
const MIN_SOURCES_WIDTH = 260;
const MAX_SOURCES_WIDTH = 650;

const DEFAULT_STUDIO_WIDTH = 380;
const MIN_STUDIO_WIDTH = 280;
const MAX_STUDIO_WIDTH = 750;

const PANEL_TRANSITION = { duration: 0.2, ease: 'easeInOut' };

function ResizeHandle({ onMouseDown, side = 'right' }) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      className={`group absolute top-0 bottom-0 z-30 w-3 flex items-center justify-center cursor-col-resize select-none ${
        side === 'right' ? '-right-1.5' : '-left-1.5'
      }`}
      title="Drag to resize sidebar"
    >
      <div className="w-1 h-full rounded-full transition-colors duration-150 group-hover:bg-accent/60 group-active:bg-accent" />
    </div>
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

function WorkspaceInner({ theme, setTheme, notebookId, notebook }) {
  const { stats, sources } = useSystem();

  // Retrieval scope: sources are included by default; unchecked ones are excluded.
  const [unchecked, setUnchecked] = useState(() => new Set());
  const [sourcesOpen, setSourcesOpen] = useState(() => loadPanelState().sourcesOpen);
  const [studioOpen, setStudioOpen] = useState(() => loadPanelState().studioOpen);
  const [sourcesWidth, setSourcesWidth] = useState(() => loadPanelState().sourcesWidth);
  const [studioWidth, setStudioWidth] = useState(() => loadPanelState().studioWidth);
  const [isResizingSources, setIsResizingSources] = useState(false);
  const [isResizingStudio, setIsResizingStudio] = useState(false);

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

      const onMouseMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = Math.min(Math.max(startWidth + delta, MIN_SOURCES_WIDTH), MAX_SOURCES_WIDTH);
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
    [sourcesWidth]
  );

  // Drag-to-resize handle for StudioPanel (right dock)
  const handleStudioMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      setIsResizingStudio(true);
      const startX = e.clientX;
      const startWidth = studioWidth;

      const onMouseMove = (moveEvent) => {
        const delta = startX - moveEvent.clientX;
        const newWidth = Math.min(Math.max(startWidth + delta, MIN_STUDIO_WIDTH), MAX_STUDIO_WIDTH);
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
    [studioWidth]
  );

  // [ / ] toggle the sidebars, ignored while typing anywhere.
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
      if (typing) return;
      if (e.key === '[') setSourcesOpen((v) => !v);
      else if (e.key === ']') setStudioOpen((v) => !v);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
        sourcesOpen={sourcesOpen}
        studioOpen={studioOpen}
        onToggleSources={() => setSourcesOpen((v) => !v)}
        onToggleStudio={() => setStudioOpen((v) => !v)}
      />
      <div className="flex flex-1 overflow-hidden relative">
        <motion.div
          key="sources"
          initial={false}
          animate={{ width: sourcesOpen ? sourcesWidth : 0 }}
          transition={isResizingSources ? { duration: 0 } : PANEL_TRANSITION}
          className="relative flex overflow-hidden flex-shrink-0"
          style={{ pointerEvents: sourcesOpen ? 'auto' : 'none' }}
        >
          <SourcesPanel
            unchecked={unchecked}
            setUnchecked={setUnchecked}
            onAdd={() => setAddOpen(true)}
            dialogOpen={addOpen}
            onOpenPdf={(filename) => setActivePdf(filename)}
          />
          {sourcesOpen && (
            <ResizeHandle onMouseDown={handleSourcesMouseDown} side="right" />
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
          animate={{ width: studioOpen ? studioWidth : 0 }}
          transition={isResizingStudio ? { duration: 0 } : PANEL_TRANSITION}
          className="relative flex overflow-hidden flex-shrink-0"
          style={{ pointerEvents: studioOpen ? 'auto' : 'none' }}
        >
          {studioOpen && (
            <ResizeHandle onMouseDown={handleStudioMouseDown} side="left" />
          )}
          <StudioPanel
            notes={notes}
            onAddNote={addNote}
            onDeleteNote={deleteNote}
            selectedSources={selected.map((s) => s.source_file)}
            questions={questions}
          />
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
    </div>
  );
}

export default function Workspace({ theme, setTheme }) {
  const { notebookId } = useParams();
  const navigate = useNavigate();
  // The notebook record (name/emoji) for the header; null until loaded.
  const [notebook, setNotebook] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotebook(null);

    (async () => {
      try {
        const { data } = await listNotebooks();
        if (cancelled) return;
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
      <WorkspaceInner theme={theme} setTheme={setTheme} notebookId={notebookId} notebook={notebook} />
    </SystemProvider>
  );
}
