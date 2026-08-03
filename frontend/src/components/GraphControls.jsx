import React from 'react';
import { Sliders, Search, RefreshCw } from 'lucide-react';

export default function GraphControls({
  minSimilarity,
  setMinSimilarity,
  repulsion,
  setRepulsion,
  searchQuery,
  setSearchQuery,
  onReset
}) {
  return (
    <div className="absolute top-4 left-4 z-10 w-80 bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-xl p-4 shadow-2xl text-slate-200 text-xs space-y-4">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2 font-semibold text-slate-100">
          <Sliders className="w-4 h-4 text-cyan-400" />
          <span>Graph Filters & Physics</span>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="p-1 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-slate-200"
          title="Reset Controls"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search Input */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter nodes..."
          className="w-full bg-slate-950/60 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
        />
      </div>

      {/* Similarity Threshold Slider */}
      <div className="space-y-1">
        <div className="flex justify-between text-[11px] text-slate-400">
          <span>Similarity Cutoff</span>
          <span className="font-mono text-cyan-400">{Math.round(minSimilarity * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.1"
          max="0.9"
          step="0.05"
          value={minSimilarity}
          onChange={(e) => setMinSimilarity(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />
      </div>

      {/* Repulsion Slider */}
      <div className="space-y-1">
        <div className="flex justify-between text-[11px] text-slate-400">
          <span>Node Repulsion</span>
          <span className="font-mono text-cyan-400">{repulsion}</span>
        </div>
        <input
          type="range"
          min="50"
          max="500"
          step="25"
          value={repulsion}
          onChange={(e) => setRepulsion(parseInt(e.target.value, 10))}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />
      </div>
    </div>
  );
}
