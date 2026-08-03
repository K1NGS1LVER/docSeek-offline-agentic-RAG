# Knowledge Graph Auto-Fitting, Collision Resolution, & Proportional Sizing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the graph canvas interactivity, spacing, framing, and node sizes:
1. **Auto-Fitting & Auto-Centering**: Implement an automatic screen-fitting calculation (`fitToScreen()`) that calculates the graph boundaries on load or reset, dynamically adjusting zoom and camera coordinates to perfectly fill the container viewport.
2. **Smooth Cursor-Centric Zooming**: Optimise wheel zoom events using a React Ref for camera values to eliminate rendering stuttering, and ensure zoom focuses directly on mouse client positions.
3. **Collision & Crowding Prevention**: Add a collision-resolution step to the physics ticks to enforce a minimum distance (`radiusA + radiusB + padding`) between nodes, preventing overlapping.
4. **Proportional Node Sizing**: Set node sizes to be proportional to their document chunk count using a square-root scaling formula (`6 + Math.sqrt(chunk_count) * 2`), removing hard clamping limits.

---

### Task 1: Auto-Fitting, Collision Physics, and Sizing Calibration

**Files:**
- Modify: `frontend/src/components/GraphCanvas.jsx`

- [ ] **Step 1: Implement Proportional Node Sizing in `GraphCanvas.jsx`**
  - Define a global helper or inline function for document node radius calculation:
    ```javascript
    const getNodeRadius = (node) => {
      if (node.is_tag) return 8; // Tag nodes have standard base radius
      return 6 + Math.sqrt(node.chunk_count || 1) * 2; // Proportional sizing
    };
    ```
  - Update all node size references (in rendering, hover detection `handleMouseMove`, and clicking `handleClick`) to use `getNodeRadius()`.

- [ ] **Step 2: Add Collision Resolution Step in rendering loop (`GraphCanvas.jsx`)**
  - Add collision prevention ticks after gravity/repulsion to push overlapping nodes apart:
    ```javascript
    nodes.forEach((nodeA) => {
      const pA = posMap.get(nodeA.id);
      if (!pA) return;
      const rA = getNodeRadius(nodeA);

      nodes.forEach((nodeB) => {
        if (nodeA.id === nodeB.id) return;
        const pB = posMap.get(nodeB.id);
        if (!pB) return;
        const rB = getNodeRadius(nodeB);

        const dx = pA.x - pB.x;
        const dy = pA.y - pB.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const minDist = rA + rB + 40; // padding safety margin
        if (dist < minDist) {
          const overlap = minDist - dist;
          const force = overlap * 0.15; // push strength
          pA.vx += (dx / dist) * force;
          pA.vy += (dy / dist) * force;
        }
      });
    });
    ```

- [ ] **Step 3: Implement Camera Ref & Auto-Fitting (`GraphCanvas.jsx`)**
  - Create a mutable camera Ref `cameraRef = useRef(camera)` to avoid restarting the render `useEffect` on every camera movement.
  - Implement `fitToScreen()` to measure node boundaries, compute scale factors, and update the camera:
    ```javascript
    const fitToScreen = () => {
      const container = containerRef.current;
      if (!container || nodes.length === 0) return;
      const width = container.clientWidth || 800;
      const height = container.clientHeight || 600;

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      nodes.forEach((node) => {
        const p = positionsRef.current.get(node.id);
        if (p) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
      });

      if (minX === Infinity) return;
      const graphWidth = maxX - minX;
      const graphHeight = maxY - minY;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      const padding = 100;
      const scaleX = (width - padding) / (graphWidth || 100);
      const scaleY = (height - padding) / (graphHeight || 100);
      const nextZoom = Math.max(0.3, Math.min(1.8, Math.min(scaleX, scaleY)));

      const nextCamera = {
        zoom: nextZoom,
        x: width / 2 - centerX * nextZoom,
        y: height / 2 - centerY * nextZoom
      };
      setCamera(nextCamera);
      cameraRef.current = nextCamera;
    };
    ```
  - Trigger `fitToScreen()` on initial load (when nodes first populate) and on window resize.

- [ ] **Step 4: Verify frontend build & linting**
  - Command: `cd frontend && npm run lint && npm run build`

- [ ] **Step 5: Commit changes**
  - Commit message: `feat(frontend): implement canvas auto-fitting, collision prevention, and proportional sizing`
