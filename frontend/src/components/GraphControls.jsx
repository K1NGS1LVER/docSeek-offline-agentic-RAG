import React from 'react';
import { Sliders, Search, RefreshCw, Sun, Moon } from 'lucide-react';
import { IconButton } from './ui';

export default function GraphControls({
  minSimilarity,
  setMinSimilarity,
  repulsion,
  setRepulsion,
  searchQuery,
  setSearchQuery,
  onReset,
  theme,
  setTheme,
}) {
  return (
    <div className="absolute top-4 left-4 z-10 w-80 bg-surface-2 border border-border rounded-xl p-4 shadow-2xl text-text text-xs space-y-4">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2 font-semibold text-text">
          <Sliders className="w-4 h-4 text-accent" />
          <span>Graph Filters & Physics</span>
        </div>
        <div className="flex items-center gap-1">
          {setTheme && (
            <IconButton
              icon={theme === 'light' ? Moon : Sun}
              size="sm"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
            />
          )}
          <IconButton
            icon={RefreshCw}
            size="sm"
            onClick={onReset}
            title="Reset Controls"
          />
        </div>
      </div>

      {/* Search Input */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter nodes..."
          className="w-full bg-surface-2 border border-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-text placeholder-text-muted focus:outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* Similarity Cutoff Slider */}
      <div className="space-y-1">
        <div className="flex justify-between text-[11px] text-text-dim">
          <span>Cutoff:</span>
          <span className="font-mono text-accent">{Math.round(minSimilarity * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.1"
          max="0.9"
          step="0.05"
          value={minSimilarity}
          onChange={(e) => setMinSimilarity(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-surface border border-border rounded-lg appearance-none cursor-pointer accent-accent"
        />
      </div>

      {/* Repulsion Slider */}
      <div className="space-y-1">
        <div className="flex justify-between text-[11px] text-text-dim">
          <span>Force:</span>
          <span className="font-mono text-accent">{repulsion}</span>
        </div>
        <input
          type="range"
          min="50"
          max="500"
          step="25"
          value={repulsion}
          onChange={(e) => setRepulsion(parseInt(e.target.value, 10))}
          className="w-full h-1.5 bg-surface border border-border rounded-lg appearance-none cursor-pointer accent-accent"
        />
      </div>
    </div>
  );
}
