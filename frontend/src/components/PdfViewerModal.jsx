import { X, ExternalLink, Download } from 'lucide-react';
import { getRawDocumentUrl } from '../lib/api';
import { IconButton } from './ui';

export default function PdfViewerModal({ notebookId, filename, onClose }) {
  const url = getRawDocumentUrl(notebookId, filename);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-border flex items-center justify-between bg-panel">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="font-serif text-base font-semibold text-text truncate">{filename}</h3>
            <span className="font-mono text-2xs px-2 py-0.5 rounded bg-accent-soft text-accent uppercase">PDF Viewer</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 text-text-muted hover:text-accent transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
            <a
              href={url}
              download={filename}
              className="p-1.5 text-text-muted hover:text-accent transition-colors"
              title="Download file"
            >
              <Download className="w-4 h-4" />
            </a>
            <IconButton icon={X} onClick={onClose} title="Close PDF Viewer" />
          </div>
        </div>

        {/* PDF Frame */}
        <div className="flex-1 bg-carbon">
          <object
            data={url}
            type="application/pdf"
            className="w-full h-full border-none"
          >
            <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center text-text-dim">
              <p className="text-sm">Your browser does not support embedded PDF viewing directly.</p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 text-xs font-medium text-black bg-accent rounded-lg hover:brightness-110"
              >
                Open PDF in new tab
              </a>
            </div>
          </object>
        </div>
      </div>
    </div>
  );
}
