import { useState, useEffect, useCallback } from 'react';
import { SystemProvider, useSystem } from '../lib/SystemContext';
import WorkspaceHeader from '../components/WorkspaceHeader';
import SourcesPanel from '../components/SourcesPanel';
import ChatPanel from '../components/ChatPanel';
import StudioPanel from '../components/StudioPanel';
import AddSourcesModal from '../components/AddSourcesModal';
import SettingsModal from '../components/SettingsModal';

const NOTES_KEY = 'ds_notes';

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY)) || [];
  } catch {
    return [];
  }
}

function WorkspaceInner({ theme, setTheme }) {
  const { stats, sources } = useSystem();

  // Retrieval scope: sources are included by default; unchecked ones are excluded.
  const [unchecked, setUnchecked] = useState(() => new Set());
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [studioOpen, setStudioOpen] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoOpenedAdd, setAutoOpenedAdd] = useState(false);
  const [notes, setNotes] = useState(loadNotes);

  useEffect(() => {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  }, [notes]);

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
        {sourcesOpen && (
          <SourcesPanel
            unchecked={unchecked}
            setUnchecked={setUnchecked}
            onAdd={() => setAddOpen(true)}
          />
        )}
        <ChatPanel
          sourceFilter={sourceFilter}
          selectedCount={selected.length}
          totalSources={sources.length}
          onSaveNote={addNote}
        />
        {studioOpen && (
          <StudioPanel
            notes={notes}
            onAddNote={addNote}
            onDeleteNote={deleteNote}
            selectedSources={selected.map((s) => s.source_file)}
          />
        )}
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
