import { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  RotateCcw,
  ArrowUpFromLine,
  ClipboardType,
} from 'lucide-react';
import { ingestText, ingestGithub } from '../lib/api';
import { useSystem } from '../lib/SystemContext';
import { Modal, SectionLabel, Button, Segmented, IconButton, inputCls, textareaCls } from './ui';

const CHUNKING_STRATEGIES = ['auto', 'recursive', 'semantic'];

function GithubMark({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

const STATUS = {
  queued: { label: 'queued', color: 'text-text-muted', icon: FileText },
  ingesting: { label: 'indexing', color: 'text-accent', icon: Loader2 },
  done: { label: 'indexed', color: 'text-success', icon: CheckCircle2 },
  error: { label: 'failed', color: 'text-caution', icon: XCircle },
};

function FileRow({ item, onRemove, onRetry }) {
  const cfg = STATUS[item.status];
  const Icon = cfg.icon;
  const spinning = ['ingesting'].includes(item.status);

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      className="flex items-center gap-3 bg-panel border border-border rounded-lg px-4 h-12"
    >
      <FileText className="w-4 h-4 text-accent flex-shrink-0" />
      <span className="text-sm font-medium text-text flex-1 truncate">{item.filename}</span>
      {item.file && (
        <span className="font-mono text-2xs text-text-muted hidden sm:block">
          {(item.file.size / 1024).toFixed(1)} KB
        </span>
      )}
      {item.chunks != null && (
        <span className="font-mono text-2xs text-text-dim">{item.chunks} chunks</span>
      )}
      <span className={`flex items-center gap-1.5 font-mono text-2xs ${cfg.color}`}>
        <Icon className={`w-3 h-3 ${spinning ? 'animate-spin' : ''}`} />
        {cfg.label}
      </span>
      <span className="flex items-center">
        {item.status === 'error' && (
          <IconButton icon={RotateCcw} onClick={() => onRetry(item.id)} title="Retry" />
        )}
        <IconButton icon={Trash2} danger onClick={() => onRemove(item.id)} title="Remove from queue" />
      </span>
    </motion.div>
  );
}

export default function AddSourcesModal({ onClose }) {
  const { notebookId } = useParams();
  const {
    refreshSources,
    refreshStats,
    refreshIngestStatus,
    uploads,
    enqueueUploads,
    startUploads,
    retryUpload,
    dismissUpload,
  } = useSystem();
  const [dragOver, setDragOver] = useState(false);
  const [strategy, setStrategy] = useState('auto');
  const [panel, setPanel] = useState(null); // 'paste' | 'github' | null
  const [pasteText, setPasteText] = useState('');
  const [pasteName, setPasteName] = useState('');
  const [pasting, setPasting] = useState(false);
  const [ghUrl, setGhUrl] = useState('');
  const [ghSub, setGhSub] = useState('');
  const fileRef = useRef(null);

  const handlePaste = async () => {
    if (!pasteText.trim()) return;
    setPasting(true);
    const name = pasteName.trim() || `pasted-${new Date().toISOString().slice(0, 10)}.txt`;
    try {
      await ingestText(notebookId, pasteText.trim(), JSON.stringify({ filename: name, source_file: name }));
      refreshSources();
      refreshStats();
      setPasteText('');
      setPasteName('');
      setPanel(null);
    } catch {
      // Non-fatal here; keep inputs so user can retry
    }
    setPasting(false);
  };

  const handleGithub = async () => {
    if (!ghUrl.trim()) return;
    try {
      await ingestGithub(notebookId, ghUrl.trim(), ghSub.trim() || null);
      setGhUrl('');
      setGhSub('');
      setPanel(null);
      refreshIngestStatus();
      onClose();
    } catch {
      // Non-fatal here; keep inputs so user can retry
    }
  };

  const queuedCount = uploads.filter((u) => u.status === 'queued').length;
  const isProcessing = uploads.some((u) => u.status === 'ingesting');

  return (
    <Modal title="Add sources" onClose={onClose}>
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); enqueueUploads(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()}
        className={`cursor-pointer border-2 border-dashed rounded-xl px-6 py-12 text-center transition-all ${
          dragOver
            ? 'border-accent bg-accent-soft'
            : 'border-border-bright hover:border-accent hover:bg-accent-soft'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.html,.htm,.docx,.pdf,.pptx"
          onChange={(e) => { enqueueUploads(e.target.files); e.target.value = ''; }}
          className="hidden"
        />
        <ArrowUpFromLine className={`w-6 h-6 mx-auto ${dragOver ? 'text-accent' : 'text-accent/70'}`} />
        <p className="font-serif text-lg text-text mt-2 mb-1">Drop files or click to browse</p>
        <p className="font-mono text-xs text-text-muted">.txt · .md · .html · .docx · .pdf · .pptx — up to 25 MB</p>
      </div>

      {/* Chunking strategy */}
      <div className="flex items-center gap-2">
        <SectionLabel className="mb-0">Chunking</SectionLabel>
        <Segmented
          mono
          value={strategy}
          onChange={setStrategy}
          options={CHUNKING_STRATEGIES.map((s) => ({ value: s, label: s }))}
        />
      </div>

      {/* Other ingestion paths */}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          icon={ClipboardType}
          onClick={() => setPanel(panel === 'paste' ? null : 'paste')}
          className="flex-1"
        >
          Paste text
        </Button>
        <Button
          variant="ghost"
          icon={GithubMark}
          onClick={() => setPanel(panel === 'github' ? null : 'github')}
          className="flex-1"
        >
          GitHub repo
        </Button>
      </div>

      {/* Inline sub-panels */}
      <AnimatePresence>
        {panel === 'paste' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pt-2">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={5}
                placeholder="Paste any text — notes, articles, transcripts…"
                className={`${textareaCls} font-mono text-xs`}
              />
              <div className="flex gap-2">
                <input
                  value={pasteName}
                  onChange={(e) => setPasteName(e.target.value)}
                  placeholder="Name (optional, e.g. meeting-notes.md)"
                  className={inputCls}
                />
                <Button
                  onClick={handlePaste}
                  disabled={!pasteText.trim() || pasting}
                  busy={pasting}
                  className="flex-shrink-0"
                >
                  {pasting ? 'Ingesting…' : 'Ingest'}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
        {panel === 'github' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pt-2">
              <input
                value={ghUrl}
                onChange={(e) => setGhUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                className={`${inputCls} font-mono text-xs`}
              />
              <div className="flex gap-2">
                <input
                  value={ghSub}
                  onChange={(e) => setGhSub(e.target.value)}
                  placeholder="Subpath (optional, e.g. docs/)"
                  className={`${inputCls} font-mono text-xs`}
                />
                <Button onClick={handleGithub} disabled={!ghUrl.trim()} className="flex-shrink-0">
                  Ingest
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload queue */}
      {uploads.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <SectionLabel className="mb-0">Queue · {uploads.length}</SectionLabel>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  uploads.forEach((u) => {
                    if (u.status !== 'ingesting') {
                      dismissUpload(u.id);
                    }
                  });
                }}
                disabled={isProcessing}
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={() => startUploads(strategy)}
                disabled={isProcessing || queuedCount === 0}
                busy={isProcessing}
              >
                {isProcessing ? 'Processing…' : `Ingest ${queuedCount}`}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <div className="space-y-2">
              <AnimatePresence>
                {uploads.map((item) => (
                  <FileRow
                    key={item.id}
                    item={item}
                    onRemove={dismissUpload}
                    onRetry={(id) => retryUpload(id, strategy)}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
