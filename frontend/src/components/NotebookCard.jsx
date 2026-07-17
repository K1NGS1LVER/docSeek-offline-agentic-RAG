import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Trash2, Loader2 } from 'lucide-react';
import { renameNotebook, deleteNotebook } from '../lib/api';
import { Card, IconButton, Modal, Button, SectionLabel, inputCls } from './ui';

function RenameModal({ notebook, onClose, onSaved }) {
  const [name, setName] = useState(notebook.name || '');
  const [emoji, setEmoji] = useState(notebook.emoji || '📓');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      await renameNotebook(notebook.id, name.trim(), emoji.trim() || '📓');
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message || 'Rename failed');
      setSaving(false);
    }
  };

  return (
    <Modal title="Rename notebook" onClose={onClose}>
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
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          />
        </div>
      </div>
      {error && <p className="text-xs text-caution">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} busy={saving} disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

export default function NotebookCard({ notebook, onChanged }) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmTimerRef = useRef(null);

  useEffect(() => {
    return () => clearTimeout(confirmTimerRef.current);
  }, []);

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      confirmTimerRef.current = setTimeout(() => setConfirming(false), 2500);
      return;
    }
    setDeleting(true);
    try {
      await deleteNotebook(notebook.id);
      onChanged?.();
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const created = notebook.created_at
    ? new Date(notebook.created_at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';
  const sourceCount = notebook.sources ?? 0;

  return (
    <>
      <Card
        className="group relative flex flex-col gap-3 p-4 cursor-pointer hover:border-accent transition-colors"
        onClick={() => navigate(`/app/${notebook.id}`)}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-3xl leading-none">{notebook.emoji || '📓'}</span>
          <div
            className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <IconButton
              icon={Pencil}
              size="sm"
              onClick={() => setRenaming(true)}
              title="Rename notebook"
            />
            <IconButton
              icon={deleting ? Loader2 : Trash2}
              size="sm"
              danger
              onClick={handleDelete}
              title={confirming ? 'Click again to delete' : 'Delete notebook'}
              className={`${confirming ? 'text-caution bg-caution-soft' : ''} ${
                deleting ? '[&_svg]:animate-spin' : ''
              }`}
            />
          </div>
        </div>
        <h3 className="font-serif text-lg font-medium text-text truncate">{notebook.name}</h3>
        <p className="font-mono text-2xs text-text-muted">
          {sourceCount} source{sourceCount === 1 ? '' : 's'} · {created}
        </p>
      </Card>
      {renaming && (
        <RenameModal
          notebook={notebook}
          onClose={() => setRenaming(false)}
          onSaved={() => onChanged?.()}
        />
      )}
    </>
  );
}
