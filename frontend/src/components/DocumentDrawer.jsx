import React from 'react';
import { X, FileText, Tag, Share2, Database } from 'lucide-react';

export default function DocumentDrawer({ node, onClose, edges = [] }) {
  if (!node) return null;

  // Find connected neighbors
  const connectedEdges = edges.filter(
    (e) => e.source === node.id || e.target === node.id
  );

  return (
    <div className="absolute top-0 right-0 z-20 w-96 h-full bg-slate-900/95 backdrop-blur-xl border-l border-slate-800 p-6 text-slate-200 shadow-2xl flex flex-col justify-between transition-all duration-300">
      <div className="space-y-6 overflow-y-auto pr-1">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-100 text-sm truncate max-w-[200px]" title={node.label}>
                {node.label}
              </h3>
              <p className="text-[11px] text-slate-400 truncate max-w-[200px] font-mono">
                {node.source_file}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
              <Database className="w-3.5 h-3.5 text-cyan-400" />
              <span>Chunks</span>
            </div>
            <p className="text-lg font-semibold text-slate-100 font-mono">{node.chunk_count}</p>
          </div>
          <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
              <Share2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Links</span>
            </div>
            <p className="text-lg font-semibold text-slate-100 font-mono">{connectedEdges.length}</p>
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Tag className="w-3.5 h-3.5 text-amber-400" />
            <span>Tags</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {node.tags && node.tags.length > 0 ? (
              node.tags.map((tag, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 bg-slate-800 border border-slate-700/60 rounded-md text-[11px] text-slate-300 font-mono"
                >
                  #{tag}
                </span>
              ))
            ) : (
              <span className="text-xs text-slate-500 italic">No tags assigned</span>
            )}
          </div>
        </div>

        {/* Connected Documents */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-300 border-b border-slate-800/60 pb-1">
            Semantic Neighbors
          </h4>
          <div className="space-y-1.5">
            {connectedEdges.length > 0 ? (
              connectedEdges.map((edge, i) => {
                const rawNeighborId = edge.source === node.id ? edge.target : edge.source;
                const neighborIdStr = typeof rawNeighborId === 'string' ? rawNeighborId : String(rawNeighborId?.id || rawNeighborId || '');
                const neighborName = neighborIdStr.split('/').pop();
                return (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 rounded-lg bg-slate-950/40 border border-slate-800/50 text-xs"
                  >
                    <span className="text-slate-300 truncate max-w-[180px] font-mono">{neighborName}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/50">
                      {Math.round((edge.weight || 0) * 100)}%
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-slate-500 italic">No connections above cutoff</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
