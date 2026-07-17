import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SystemProvider, useSystem } from '../lib/SystemContext';
import WorkspaceHeader from '../components/WorkspaceHeader';
import SourcesPanel from '../components/SourcesPanel';
import ChatPanel from '../components/ChatPanel';
import StudioPanel from '../components/StudioPanel';
import AddSourcesModal from '../components/AddSourcesModal';
import SettingsModal from '../components/SettingsModal';

const NOTES_KEY = 'ds_notes';
const PANELS_KEY = 'ds_panels';
// Must match SourcesPanel.jsx's w-72 / StudioPanel.jsx's w-80 (theme.css
// --sources-w / --studio-w) so the slide animation lands on the panel's
// real rendered width.
const SOURCES_WIDTH = 288;
const STUDIO_WIDTH = 320;
const PANEL_TRANSITION = { duration: 0.2, ease: 'easeInOut' };

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY)) || [];
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
    };
  } catch {
    return { sourcesOpen: true, studioOpen: true };
  }
}

function WorkspaceInner({ theme, setTheme }) {
  const { stats, sources } = useSystem();

  // Retrieval scope: sources are included by default; unchecked ones are excluded.
  const [unchecked, setUnchecked] = useState(() => new Set());
  const [sourcesOpen, setSourcesOpen] = useState(() => loadPanelState().sourcesOpen);
  const [studioOpen, setStudioOpen] = useState(() => loadPanelState().studioOpen);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoOpenedAdd, setAutoOpenedAdd] = useState(false);
  const [notes, setNotes] = useState(loadNotes);
  const [questions, setQuestions] = useState([]);

  useEffect(() => {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  }, [notes]);

  useEffect(() => {
    localStorage.setItem(PANELS_KEY, JSON.stringify({ sourcesOpen, studioOpen }));
  }, [sourcesOpen, studioOpen]);

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
        onOpenSettings={() => setSettingsOpen(true)}
        sourcesOpen={sourcesOpen}
        studioOpen={studioOpen}
        onToggleSources={() => setSourcesOpen((v) => !v)}
        onToggleStudio={() => setStudioOpen((v) => !v)}
      />
      <div className="flex flex-1 overflow-hidden">
        <AnimatePresence initial={false}>
          {sourcesOpen && (
            <motion.div
              key="sources"
              initial={{ width: 0 }}
              animate={{ width: SOURCES_WIDTH }}
              exit={{ width: 0 }}
              transition={PANEL_TRANSITION}
              className="flex overflow-hidden flex-shrink-0"
            >
              <SourcesPanel
                unchecked={unchecked}
                setUnchecked={setUnchecked}
                onAdd={() => setAddOpen(true)}
              />
            </motion.div>
          )}
        </AnimatePresence>
        <ChatPanel
          sourceFilter={sourceFilter}
          selectedCount={selected.length}
          totalSources={sources.length}
          onSaveNote={addNote}
          onQuestionsChange={setQuestions}
        />
        <AnimatePresence initial={false}>
          {studioOpen && (
            <motion.div
              key="studio"
              initial={{ width: 0 }}
              animate={{ width: STUDIO_WIDTH }}
              exit={{ width: 0 }}
              transition={PANEL_TRANSITION}
              className="flex overflow-hidden flex-shrink-0"
            >
              <StudioPanel
                notes={notes}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
                selectedSources={selected.map((s) => s.source_file)}
                questions={questions}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {addOpen && <AddSourcesModal onClose={() => setAddOpen(false)} />}
      {settingsOpen && (
        <SettingsModal theme={theme} setTheme={setTheme} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

export default function Workspace({ theme, setTheme }) {
  return (
    <SystemProvider>
      <WorkspaceInner theme={theme} setTheme={setTheme} />
    </SystemProvider>
  );
}
