# Design Specification: Knowledge Graph Design Alignment & Canvas Display Fix

**Date**: 2026-08-03  
**Status**: Approved  
**Target Feature**: Document Knowledge Graph Design System & Display Fix  

---

## 1. Overview & Goal

This specification addresses two major issues with the Knowledge Graph view:
1. **Canvas Display Bug**: The canvas element previously collapsed to 0 height in CSS flexbox layouts, preventing nodes from being rendered on screen.
2. **Design Language Alignment & Header Layout**: The view previously hardcoded dark slate colors (`#0b0f19`, `bg-slate-900`) and placed the back button on the right side. This spec aligns the page with docSeek's official theme variables (`theme.css` tokens: `bg-carbon`, `bg-surface`, `border-border`, `text-text`, `text-accent`, dark/cream theme adaptability) and moves the **Notebook Back Button** to the top-left while anchoring metric controls on the top-right.

---

## 2. Header & Control Bar Redesign

### Header Layout (`GraphPage.jsx` & `GraphControls.jsx`)
- **Top Bar**: Fixed height `h-14 bg-surface border-b border-border text-text px-6 flex items-center justify-between shadow-sm`.
- **Left Side**:
  - `<Link to={notebookId ? \`/app/\${notebookId}\` : '/app'}>` back button with `<ArrowLeft className="w-4 h-4 text-accent" />` + `"Notebook"`.
  - Brand & Section Title: `docSeek Knowledge Graph` in `font-serif`.
- **Right Side**:
  - Similarity Cutoff Slider ($10\% \dots 90\%$) with live `%` value badge.
  - Node Repulsion Slider ($50 \dots 500$).
  - Search filter input with icon.
  - Reset controls button & Theme toggle button (Sun/Moon).

---

## 3. Canvas Display & Layout Fix

### Flexbox Height & Centering (`GraphCanvas.jsx` & `GraphPage.jsx`)
- Container wrap: `<div className="flex-1 w-full relative overflow-hidden bg-carbon">`.
- `GraphCanvas.jsx` layout:
  - Measures `canvas.clientWidth` and `canvas.clientHeight` dynamically.
  - Centers initial node 2D positions around `width / 2`, `height / 2`.
- **Empty State Card**:
  - If `nodes.length === 0` (e.g. fresh notebook with no ingested docs), renders docSeek's standard empty state container with icon `<Share2 className="w-8 h-8 text-accent" />` and guidance message instead of a blank canvas.

---

## 4. Theme-Aware Design System Integration

### Color Tokens & Canvas Styling
- Dynamically reads theme colors from `document.documentElement` / `getComputedStyle`:
  - **Background Fill**: `var(--bg)` (`#111110` in warm dark mode, `#f5eedc` in cream light mode).
  - **Core Node Fill**: `var(--accent)` (`#d97706` in dark mode, `#a3480a` in light mode).
  - **Node Glow**: `var(--accent-soft)` / `var(--accent-2)`.
  - **Edge Stroke**: `var(--border-bright)`.
  - **Text Labels**: `var(--text-1)` / `var(--text-2)` with `font-sans` / `font-mono`.
- **Document Preview Drawer (`DocumentDrawer.jsx`)**:
  - Glassmorphism slide-over styled using `bg-surface/95 border-l border-border text-text shadow-2xl`.
  - Uses docSeek metric cards (`bg-surface-2 border border-border rounded-xl p-3`).

---

## 5. Verification Plan

- **Automated Tests**:
  - Pytest backend unit & API tests: `.venv/bin/python -m pytest tests/test_graph.py tests/e2e/test_graph_api.py -v`.
  - Frontend production build & lint: `cd frontend && npm run lint && npm run build`.
- **Manual Verification**:
  - Open `/graph` and `/app/:notebookId/graph` in browser in both light & dark themes.
  - Verify back button on top-left, controls on top-right, nodes rendered clearly at center of canvas, and preview drawer opening on node click.
