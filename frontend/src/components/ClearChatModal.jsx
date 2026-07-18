import { Download, Trash2 } from 'lucide-react';
import { Modal, Button } from './ui';

/** Confirmation modal for clearing a notebook's chat thread, with an escape
    hatch to download the transcript first. Presentational only — all state
    and the actual clear/download logic live in ChatPanel. */
export default function ClearChatModal({ onDownload, onConfirm, onClose }) {
  return (
    <Modal title="Clear chat?" onClose={onClose}>
      <p className="text-sm text-text-dim leading-relaxed">
        This removes the conversation for this notebook only — your sources and notes are not
        affected. This can&rsquo;t be undone.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" icon={Download} onClick={onDownload}>
          Download transcript
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="dangerSolid" icon={Trash2} onClick={onConfirm}>
          Clear chat
        </Button>
      </div>
    </Modal>
  );
}
