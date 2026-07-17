import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Sun, Moon, Loader2, NotebookPen } from 'lucide-react';
import { listNotebooks, createNotebook } from '../lib/api';
import { Button, IconButton, Modal, SectionLabel, inputCls } from '../components/ui';
import NotebookCard from '../components/NotebookCard';

function CreateNotebookModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('📓');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const { data } = await createNotebook(name.trim(), emoji.trim() || '📓');
      onCreated(data);
    } catch (e) {
      setError(e.message || 'Could not create notebook');
      setCreating(false);
    }
  };

  return (
    <Modal title="New notebook" onClose={onClose}>
      <div className="flex gap-3">
        <div className="w-20 flex-shrink-0">
          <SectionLabel className="mb-1">Emoji</SectionLabel>
          <input
            className={`${inputCls} text-center text-lg`}
            value={emoji}
            maxLength={4}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-0">
          <SectionLabel className="mb-1">Name</SectionLabel>
          <input
            className={inputCls}
            value={name}
            autoFocus
            placeholder="Untitled notebook"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
        </div>
      </div>
      {error && <p className="text-xs text-caution">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleCreate} busy={creating} disabled={!name.trim()}>
          Create
        </Button>
      </div>
    </Modal>
  );
}

export default function NotebooksPage({ theme, setTheme }) {
  const navigate = useNavigate();
  const [notebooks, setNotebooks] = useState(null); // null = loading
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const { data } = await listNotebooks();
      setNotebooks(data || []);
    } catch (e) {
      setError(e.message || 'Could not load notebooks');
      setNotebooks([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  return (
    <div className="min-h-screen flex flex-col bg-carbon text-text">
      <header className="h-14 flex-shrink-0 flex items-center gap-4 px-6 bg-surface border-b border-border">
        <Link to="/" className="font-serif font-semibold text-lg tracking-tight text-text">
          doc<span className="text-accent">Seek</span>
        </Link>
        <div className="flex-1" />
        <IconButton
          size="md"
          icon={theme === 'light' ? Moon : Sun}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          title={theme === 'light' ? 'Switch to dark' : 'Switch to cream'}
        />
      </header>

      <main className="flex-1 w-full max-w-[1100px] mx-auto px-8 py-12">
        <div className="flex items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="font-serif text-2xl font-medium text-text">Notebooks</h1>
            <p className="text-sm text-text-dim mt-1">
              Pick a notebook to keep working, or start a new one.
            </p>
          </div>
          {notebooks && notebooks.length > 0 && (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              New notebook
            </Button>
          )}
        </div>

        {notebooks === null ? (
          <div className="flex items-center justify-center py-24 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : notebooks.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-24 text-center">
            <NotebookPen className="w-8 h-8 text-text-muted" />
            <p className="text-sm text-text-dim max-w-sm">
              No notebooks yet. Create one to start uploading sources and asking questions.
            </p>
            <Button icon={Plus} onClick={() => setCreating(true)}>
              Create your first notebook
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {notebooks.map((nb) => (
              <NotebookCard key={nb.id} notebook={nb} onChanged={refresh} />
            ))}
          </div>
        )}

        {error && <p className="text-xs text-caution mt-4">{error}</p>}
      </main>

      {creating && (
        <CreateNotebookModal
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            navigate(`/app/${created?.id}`);
          }}
        />
      )}
    </div>
  );
}
