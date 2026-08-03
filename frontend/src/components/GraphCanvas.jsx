import React, { useRef, useEffect, useState } from 'react';

export default function GraphCanvas({
  nodes = [],
  edges = [],
  repulsion = 200,
  searchQuery = '',
  onSelectNode
}) {
  const canvasRef = useRef(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);

  // Store 2D positions for physics simulation
  const positionsRef = useRef(new Map());

  // Initialize/update particle layout
  useEffect(() => {
    const width = canvasRef.current?.clientWidth || 800;
    const height = canvasRef.current?.clientHeight || 600;

    // Assign random initial positions if not set
    nodes.forEach((node, i) => {
      if (!positionsRef.current.has(node.id)) {
        const angle = (i / (nodes.length || 1)) * 2 * Math.PI;
        const radius = 150 + Math.random() * 100;
        positionsRef.current.set(node.id, {
          x: width / 2 + radius * Math.cos(angle),
          y: height / 2 + radius * Math.sin(angle),
          vx: 0,
          vy: 0
        });
      }
    });
  }, [nodes]);

  // Non-passive wheel event listener for zooming canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      setCamera((prev) => ({
        ...prev,
        zoom: Math.max(0.2, Math.min(4, prev.zoom * zoomFactor))
      }));
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, []);

  // Main render & physics loop
  useEffect(() => {
    let animId;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const render = () => {
      const width = (canvas.width = canvas.clientWidth || 800);
      const height = (canvas.height = canvas.clientHeight || 600);

      // Physics step (Simple spring-repulsion layout)
      const posMap = positionsRef.current;
      nodes.forEach((nodeA) => {
        const pA = posMap.get(nodeA.id);
        if (!pA) return;

        // Repulsion between all nodes
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

      // Edge spring attraction
      edges.forEach((edge) => {
        const pA = posMap.get(edge.source);
        const pB = posMap.get(edge.target);
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

      // Update positions & friction
      nodes.forEach((node) => {
        const p = posMap.get(node.id);
        if (!p) return;
        p.vx *= 0.85;
        p.vy *= 0.85;
        p.x += p.vx;
        p.y += p.vy;
      });

      // Draw background (Obsidian cosmic dark)
      ctx.fillStyle = '#0b0f19';
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(camera.x, camera.y);
      ctx.scale(camera.zoom, camera.zoom);

      // Draw Edges
      edges.forEach((edge) => {
        const pA = posMap.get(edge.source);
        const pB = posMap.get(edge.target);
        if (!pA || !pB) return;

        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
        ctx.strokeStyle =
          edge.type === 'tag'
            ? 'rgba(52, 211, 153, 0.25)'
            : 'rgba(56, 189, 248, 0.25)';
        ctx.lineWidth = Math.max(1, (edge.weight || 0.5) * 2.5);
        ctx.stroke();
      });

      // Draw Nodes
      nodes.forEach((node) => {
        const p = posMap.get(node.id);
        if (!p) return;

        const isHovered = hoveredNode === node.id;
        const isMatched =
          searchQuery &&
          node.label?.toLowerCase().includes(searchQuery.toLowerCase());
        const radius = Math.max(6, Math.min(18, (node.chunk_count || 1) * 1.5));

        // Outer Glow
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + (isHovered ? 8 : 4), 0, 2 * Math.PI);
        ctx.fillStyle = isMatched
          ? 'rgba(244, 63, 94, 0.3)'
          : isHovered
          ? 'rgba(56, 189, 248, 0.4)'
          : 'rgba(56, 189, 248, 0.1)';
        ctx.fill();

        // Core Node
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = isMatched
          ? '#f43f5e'
          : isHovered
          ? '#38bdf8'
          : '#0284c7';
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Label
        ctx.fillStyle = isHovered ? '#ffffff' : '#94a3b8';
        ctx.font = `${isHovered ? '600' : '400'} 11px Inter, sans-serif`;
        ctx.fillText(node.label || '', p.x + radius + 6, p.y + 4);
      });

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [nodes, edges, repulsion, camera, hoveredNode, searchQuery]);

  // Mouse Handlers for Pan & Node Click
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
      // Hit testing for hover
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left - camera.x) / camera.zoom;
      const mouseY = (e.clientY - rect.top - camera.y) / camera.zoom;

      let found = null;
      nodes.forEach((node) => {
        const p = positionsRef.current.get(node.id);
        if (!p) return;
        const dx = mouseX - p.x;
        const dy = mouseY - p.y;
        const radius = Math.max(6, Math.min(18, (node.chunk_count || 1) * 1.5));
        if (Math.sqrt(dx * dx + dy * dy) <= Math.max(15, radius)) {
          found = node.id;
        }
      });
      setHoveredNode(found);
    }
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  const handleClick = (e) => {
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left - camera.x) / camera.zoom;
    const mouseY = (e.clientY - rect.top - camera.y) / camera.zoom;

    nodes.forEach((node) => {
      const p = positionsRef.current.get(node.id);
      if (!p) return;
      const dx = mouseX - p.x;
      const dy = mouseY - p.y;
      const radius = Math.max(6, Math.min(18, (node.chunk_count || 1) * 1.5));
      if (Math.sqrt(dx * dx + dy * dy) <= Math.max(15, radius)) {
        if (onSelectNode) onSelectNode(node);
      }
    });
  };

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      className="w-full h-full cursor-grab active:cursor-grabbing"
    />
  );
}
