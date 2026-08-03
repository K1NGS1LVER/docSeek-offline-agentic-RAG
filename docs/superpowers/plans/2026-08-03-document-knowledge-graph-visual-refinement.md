# Knowledge Graph Visual Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the knowledge graph's interactive feel and visual presentation by:
1. Making mouse-wheel zoom sensitivity significantly smoother and less jerky.
2. Increasing default layout separation between nodes (avoiding crowded clumps).
3. Reducing node visual sizes so they look like elegant, modern network nodes rather than heavy circles.

---

### Task 1: Refining Physics, Node Sizes, and Zoom Sensitivity

**Files:**
- Modify: `frontend/src/components/GraphCanvas.jsx`
- Modify: `frontend/src/components/GraphControls.jsx`
- Modify: `frontend/src/pages/GraphPage.jsx`

- [ ] **Step 1: Update Zoom Handling in `GraphCanvas.jsx` to zoom on cursor**
  - Smooth out wheel zoom sensitivity and zoom relative to the mouse cursor position in container space:
    ```javascript
    const handleWheel = (e) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = Math.max(0.8, Math.min(1.2, 1 - e.deltaY * 0.0015));
      
      setCamera((prev) => {
        const nextZoom = Math.max(0.15, Math.min(4, prev.zoom * zoomFactor));
        const mouseWorldX = (mouseX - prev.x) / prev.zoom;
        const mouseWorldY = (mouseY - prev.y) / prev.zoom;
        return {
          zoom: nextZoom,
          x: mouseX - mouseWorldX * nextZoom,
          y: mouseY - mouseWorldY * nextZoom
        };
      });
    };
    ```

- [ ] **Step 2: Increase Layout Separation & Spacing in `GraphCanvas.jsx`**
  - Increase initial circular placement radius to spread nodes out from the start:
    ```javascript
    const radius = 200 + Math.random() * 120;
    ```
  - Increase spring rest length from `120` to `220` (and adjust spring multiplier to `0.008` to prevent spring oscillation) to push connected nodes further apart:
    ```javascript
    const springForce = (dist - 220) * 0.008 * (edge.weight || 0.5);
    ```

- [ ] **Step 3: Reduce Node Circle Sizes & Align Hit Detection in `GraphCanvas.jsx`**
  - Change radius calculation to make nodes smaller and more elegant:
    ```javascript
    const radius = Math.max(5, Math.min(12, (node.chunk_count || 1) * 0.8));
    ```
  - Adjust hover glow radius to match: `radius + (isHovered ? 6 : 3)`.
  - Align radius calculations inside `handleMouseMove` and `handleClick` to match:
    ```javascript
    const radius = Math.max(5, Math.min(12, (node.chunk_count || 1) * 0.8));
    const maxHitRadius = Math.max(12, radius);
    ```

- [ ] **Step 4: Update Controls & Spacing Constants in `GraphControls.jsx` & `GraphPage.jsx`**
  - Scale up default layout repulsion force range (e.g. default repulsion = `350`, range = `100` to `800`) to give users more control over node separation.
  - Update `GraphPage.jsx` state defaults to match:
    ```javascript
    const [repulsion, setRepulsion] = useState(350);
    ```

- [ ] **Step 5: Verify build & lint**
  - Command: `cd frontend && npm run lint && npm run build`

- [ ] **Step 6: Commit changes**
  - Commit message: `style(frontend): adjust graph zoom to cursor, spacing separation, and node size scale`
