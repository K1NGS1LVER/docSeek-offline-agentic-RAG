import React from 'react';
import { Search, RefreshCw, Sun, Moon } from 'lucide-react';
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
    <div className="flex items-center gap-3 text-text text-xs">
      {/* Search Input */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-text-muted pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter nodes..."
          className="w-40 bg-surface-2 border border-border rounded-lg pl-8 pr-3 py-1 text-xs text-text placeholder-text-muted focus:outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* Similarity Cutoff Slider */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-text-dim whitespace-nowrap">Cutoff:</span>
        <input
          type="range"
          min="0.1"
          max="0.9"
          step="0.05"
          value={minSimilarity}
          onChange={(e) => setMinSimilarity(parseFloat(e.target.value))}
          className="w-20 h-1.5 bg-surface border border-border rounded-lg appearance-none cursor-pointer accent-accent"
        />
        <span className="font-mono text-accent text-[11px] w-7">{Math.round(minSimilarity * 100)}%</span>
      </div>

      {/* Repulsion / Force Slider */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-text-dim whitespace-nowrap">Force:</span>
        <input
          type="range"
          min="50"
          max="500"
          step="25"
          value={repulsion}
          onChange={(e) => setRepulsion(parseInt(e.target.value, 10))}
          className="w-20 h-1.5 bg-surface border border-border rounded-lg appearance-none cursor-pointer accent-accent"
        />
        <span className="font-mono text-accent text-[11px] w-7">{repulsion}</span>
      </div>

      {/* Reset Button */}
      <IconButton
        icon={RefreshCw}
        size="sm"
        onClick={onReset}
        title="Reset Controls"
      />

      {/* Theme Toggle */}
      {setTheme && (
        <IconButton
          icon={theme === 'light' ? Moon : Sun}
          size="sm"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
        />
      )}
    </div>
  );
}
