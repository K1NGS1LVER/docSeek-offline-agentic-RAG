import React from 'react';
import { X, FileText, Tag, Share2, Database } from 'lucide-react';

export default function DocumentDrawer({ node, onClose, edges = [] }) {
  if (!node) return null;

  const getId = (endpoint) => (typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint);

  // Find connected neighbors
  const connectedEdges = edges.filter(
    (e) => getId(e.source) === node.id || getId(e.target) === node.id
  );

  return (
    <div className="absolute top-14 right-0 z-20 w-96 h-[calc(100vh-56px)] bg-surface/95 backdrop-blur-xl border-l border-border p-6 text-text shadow-2xl flex flex-col justify-between transition-all duration-300">
      <div className="space-y-6 overflow-y-auto pr-1">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent-soft border border-accent/20 rounded-xl text-accent">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-serif font-medium text-text text-sm truncate max-w-[200px]" title={node.label}>
                {node.label}
              </h3>
              <p className="text-2xs text-text-dim truncate max-w-[200px] font-mono">
                {node.source_file}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-surface-2 rounded-lg text-text-dim hover:text-text transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="bg-surface-2 border border-border rounded-xl p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-text-dim text-[11px]">
              <Database className="w-3.5 h-3.5 text-accent" />
              <span>Chunks</span>
            </div>
            <p className="text-lg font-semibold text-text font-mono">{node.chunk_count}</p>
          </div>
          <div className="bg-surface-2 border border-border rounded-xl p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-text-dim text-[11px]">
              <Share2 className="w-3.5 h-3.5 text-accent" />
              <span>Links</span>
            </div>
            <p className="text-lg font-semibold text-text font-mono">{connectedEdges.length}</p>
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-text-dim">
            <Tag className="w-3.5 h-3.5 text-accent" />
            <span>Tags</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {node.tags && node.tags.length > 0 ? (
              node.tags.map((tag, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 bg-surface-2 border border-border rounded-md text-[11px] text-text-dim font-mono"
                >
                  #{tag}
                </span>
              ))
            ) : (
              <span className="text-xs text-text-dim italic">No tags assigned</span>
            )}
          </div>
        </div>

        {/* Connected Documents */}
        <div className="space-y-2">
          <h4 className="text-xs font-serif font-medium text-text border-b border-border pb-1">
            Semantic Neighbors
          </h4>
          <div className="space-y-1.5">
            {connectedEdges.length > 0 ? (
              connectedEdges.map((edge, i) => {
                const rawNeighborId = getId(edge.source) === node.id ? getId(edge.target) : getId(edge.source);
                const neighborIdStr = typeof rawNeighborId === 'string' ? rawNeighborId : String(rawNeighborId || '');
                const neighborName = neighborIdStr.split('/').pop();
                return (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 rounded-lg bg-surface-2 border border-border text-xs"
                  >
                    <span className="text-text-dim truncate max-w-[180px] font-mono">{neighborName}</span>
                    <span className="text-2xs font-mono px-1.5 py-0.5 rounded bg-accent-soft text-accent border border-accent/20">
                      {Math.round((edge.weight || 0) * 100)}%
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-text-dim italic">No connections above cutoff</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

