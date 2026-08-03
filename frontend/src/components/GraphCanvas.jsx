import React, { useRef, useEffect, useState } from 'react';
import { Share2 } from 'lucide-react';

// Helper to read current theme colors from CSS variables or theme prop
const getThemePalette = (theme) => {
  const isLight =
    theme === 'light' ||
    (typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'light');
  return {
    bg: isLight ? '#f5eedc' : '#111110',
    nodeCore: isLight ? '#a3480a' : '#d97706',
    nodeHover: isLight ? '#8a3c08' : '#e88d1a',
    nodeGlow: isLight ? 'rgba(163, 72, 10, 0.25)' : 'rgba(217, 119, 6, 0.25)',
    edgeStroke: isLight ? 'rgba(163, 72, 10, 0.25)' : 'rgba(217, 119, 6, 0.25)',
    tagStroke: isLight ? 'rgba(22, 101, 52, 0.35)' : 'rgba(22, 163, 74, 0.35)',
    tagNode: isLight ? '#166534' : '#16a34a',
    matchNode: isLight ? '#b91c1c' : '#ef4444',
    text: isLight ? '#1c1914' : '#f5f3ef',
    textDim: isLight ? '#5d5347' : '#918d85',
    stroke: isLight ? 'rgba(28, 25, 20, 0.16)' : 'rgba(255, 255, 255, 0.14)'
  };
};

export default function GraphCanvas({
  nodes = [],
  edges = [],
  repulsion = 200,
  searchQuery = '',
  onSelectNode,
  theme = 'dark'
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);
  const positionsRef = useRef(new Map());

  // Initialize/update particle positions around container center
  useEffect(() => {
    const container = containerRef.current;
    const width = container?.clientWidth || 800;
    const height = container?.clientHeight || 600;

    nodes.forEach((node, i) => {
      if (!positionsRef.current.has(node.id)) {
        const angle = (i / (nodes.length || 1)) * 2 * Math.PI;
        const radius = 120 + Math.random() * 80;
        positionsRef.current.set(node.id, {
          x: width / 2 + radius * Math.cos(angle),
          y: height / 2 + radius * Math.sin(angle),
          vx: 0,
          vy: 0
        });
      }
    });
  }, [nodes]);

  // Non-passive wheel event listener for zooming
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      setCamera((prev) => ({
        ...prev,
        zoom: Math.max(0.2, Math.min(4, prev.zoom * zoomFactor))
      }));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // Main render & physics loop
  useEffect(() => {
    let animId;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');

    const render = () => {
      const clientWidth = container.clientWidth || 800;
      const clientHeight = container.clientHeight || 600;

      if (canvas.width !== clientWidth) canvas.width = clientWidth;
      if (canvas.height !== clientHeight) canvas.height = clientHeight;

      const width = canvas.width;
      const height = canvas.height;
      const palette = getThemePalette(theme);

      // Physics step
      const posMap = positionsRef.current;
      nodes.forEach((nodeA) => {
        const pA = posMap.get(nodeA.id);
        if (!pA) return;

        nodes.forEach((nodeB) => {
          if (nodeA.id === nodeB.id) return;
          const pB = posMap.get(nodeB.id);
          if (!pB) return;

          const dx = pA.x - pB.x;
          const dy = pA.y - pB.y;
          const distSq = dx * dx + dy * dy + 0.1;
          const dist = Math.sqrt(distSq);
          const force = repulsion / distSq;
          pA.vx += (dx / dist) * force * 0.1;
          pA.vy += (dy / dist) * force * 0.1;
        });
      });

      // Edge spring attraction with normalized endpoints
      edges.forEach((edge) => {
        const getId = (endpoint) =>
          typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
        const pA = posMap.get(getId(edge.source));
        const pB = posMap.get(getId(edge.target));
        if (!pA || !pB) return;

        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const springForce = (dist - 120) * 0.01 * (edge.weight || 0.5);

        pA.vx += (dx / dist) * springForce;
        pA.vy += (dy / dist) * springForce;
        pB.vx -= (dx / dist) * springForce;
        pB.vy -= (dy / dist) * springForce;
      });

      // Position update & friction
      nodes.forEach((node) => {
        const p = posMap.get(node.id);
        if (!p) return;
        p.vx *= 0.85;
        p.vy *= 0.85;
        p.x += p.vx;
        p.y += p.vy;
      });

      // Background fill
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(camera.x, camera.y);
      ctx.scale(camera.zoom, camera.zoom);

      // Draw Edges
      edges.forEach((edge) => {
        const getId = (endpoint) =>
          typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
        const pA = posMap.get(getId(edge.source));
        const pB = posMap.get(getId(edge.target));
        if (!pA || !pB) return;

        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
        ctx.strokeStyle = edge.type === 'tag' ? palette.tagStroke : palette.edgeStroke;
        ctx.lineWidth = Math.max(1.5, (edge.weight || 0.5) * 3);
        ctx.stroke();
      });

      // Draw Nodes
      nodes.forEach((node) => {
        const p = posMap.get(node.id);
        if (!p) return;

        const isHovered = hoveredNode === node.id;
        const isMatched =
          searchQuery && node.label?.toLowerCase().includes(searchQuery.toLowerCase());
        const isTag = Boolean(node.is_tag);
        const radius = Math.max(8, Math.min(20, (node.chunk_count || 1) * 1.5));

        // Outer Glow
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + (isHovered ? 8 : 4), 0, 2 * Math.PI);
        ctx.fillStyle = isMatched
          ? 'rgba(239, 68, 68, 0.3)'
          : isHovered
          ? palette.nodeGlow
          : 'rgba(217, 119, 6, 0.12)';
        ctx.fill();

        // Core Node
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = isMatched
          ? palette.matchNode
          : isHovered
          ? palette.nodeHover
          : isTag
          ? palette.tagNode
          : palette.nodeCore;
        ctx.fill();
        ctx.strokeStyle = palette.stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Label
        ctx.fillStyle = isHovered ? palette.text : palette.textDim;
        ctx.font = `${isHovered ? '600' : '400'} 12px "DM Sans", system-ui, sans-serif`;
        ctx.fillText(node.label || '', p.x + radius + 6, p.y + 4);
      });

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [nodes, edges, repulsion, camera, hoveredNode, searchQuery, theme]);

  const handleMouseDown = (e) => {
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX - camera.x, y: e.clientY - camera.y };
    hasDraggedRef.current = false;
  };

  const handleMouseMove = (e) => {
    if (isDraggingRef.current) {
      const dx = e.clientX - dragStartRef.current.x - camera.x;
      const dy = e.clientY - dragStartRef.current.y - camera.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasDraggedRef.current = true;
      }
      setCamera((prev) => ({
        ...prev,
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y
      }));
    } else {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left - camera.x) / camera.zoom;
      const mouseY = (e.clientY - rect.top - camera.y) / camera.zoom;

      let found = null;
      let minDistance = Infinity;

      nodes.forEach((node) => {
        const p = positionsRef.current.get(node.id);
        if (!p) return;
        const dx = mouseX - p.x;
        const dy = mouseY - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const radius = Math.max(8, Math.min(20, (node.chunk_count || 1) * 1.5));
        const maxHitRadius = Math.max(16, radius);
        if (dist <= maxHitRadius && dist < minDistance) {
          minDistance = dist;
          found = node.id;
        }
      });
      setHoveredNode(found);
    }
  };

  const handleClick = (e) => {
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left - camera.x) / camera.zoom;
    const mouseY = (e.clientY - rect.top - camera.y) / camera.zoom;

    let closestNode = null;
    let minDistance = Infinity;

    nodes.forEach((node) => {
      const p = positionsRef.current.get(node.id);
      if (!p) return;
      const dx = mouseX - p.x;
      const dy = mouseY - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const radius = Math.max(8, Math.min(20, (node.chunk_count || 1) * 1.5));
      const maxHitRadius = Math.max(16, radius);
      if (dist <= maxHitRadius && dist < minDistance) {
        minDistance = dist;
        closestNode = node;
      }
    });

    if (closestNode && onSelectNode) {
      onSelectNode(closestNode);
    }
  };

  if (!nodes || nodes.length === 0) {
    return (
      <div className="flex-1 w-full h-full flex flex-col items-center justify-center p-8 text-center bg-carbon text-text-dim">
        <div className="w-16 h-16 rounded-2xl bg-accent-soft border border-accent/20 flex items-center justify-center mb-4">
          <Share2 className="w-7 h-7 text-accent" />
        </div>
        <h3 className="font-serif text-lg font-medium text-text mb-1">
          No documents in knowledge graph
        </h3>
        <p className="text-xs text-text-dim max-w-sm">
          Upload documents to this notebook to build interactive 2D semantic relationship maps.
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 w-full h-full relative overflow-hidden bg-carbon">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={() => {
          isDraggingRef.current = false;
        }}
        onClick={handleClick}
        className="w-full h-full cursor-grab active:cursor-grabbing block"
      />
    </div>
  );
}

