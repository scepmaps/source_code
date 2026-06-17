class MappingGrid {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.gridSize = 60;
    this.time = 0;
    this.cols = 0;
    this.rows = 0;
    // Flat array indexed by col * this.rows + row for O(1) neighbour lookup.
    this.waypoints = [];
    this.mouseRadius = 200;
    this.scanLines = [];

    this.resize();
    this.createWaypoints();
    this.createScanLines();
    this.bindEvents();
    this.animate();
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  createWaypoints() {
    this.cols = Math.ceil(this.canvas.width / this.gridSize) + 1;
    this.rows = Math.ceil(this.canvas.height / this.gridSize) + 1;
    this.waypoints = [];
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        this.waypoints.push({
          x: c * this.gridSize,
          y: r * this.gridSize,
          baseX: c * this.gridSize,
          baseY: r * this.gridSize,
          active: false,
          elevation: 0,
          signal: Math.random(),
        });
      }
    }
  }

  getWaypoint(col, row) {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;
    return this.waypoints[col * this.rows + row];
  }

  createScanLines() {
    this.scanLines = [];
    for (let i = 0; i < 3; i++) {
      this.scanLines.push({
        angle: (i * 120) * (Math.PI / 180),
        length: 0,
        maxLength: Math.sqrt(this.canvas.width ** 2 + this.canvas.height ** 2),
        speed: 2 + i * 0.5,
      });
    }
  }

  bindEvents() {
    window.addEventListener('resize', () => {
      this.resize();
      this.createWaypoints();
      this.createScanLines();
    });
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
  }

  updateWaypoints() {
    const mx = this.mouse.x;
    const my = this.mouse.y;
    const r = this.mouseRadius;
    const r15 = r * 1.5;
    for (let i = 0; i < this.waypoints.length; i++) {
      const pt = this.waypoints[i];
      const dx = mx - pt.baseX;
      const dy = my - pt.baseY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < r) {
        const force = (r - dist) / r;
        pt.elevation = force * 20;
        pt.active = true;
        const angle = Math.atan2(dy, dx);
        pt.x = pt.baseX + Math.cos(angle) * force * 15;
        pt.y = pt.baseY + Math.sin(angle) * force * 15;
      } else {
        pt.elevation *= 0.95;
        pt.active = dist < r15;
        pt.x += (pt.baseX - pt.x) * 0.1;
        pt.y += (pt.baseY - pt.y) * 0.1;
      }
    }
  }

  drawCoordinateGrid() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const gs = this.gridSize;

    ctx.strokeStyle = 'rgba(77, 226, 255, 0.15)';
    ctx.lineWidth = 0.5;

    // Batch all vertical + horizontal lines into a single path.
    ctx.beginPath();
    for (let x = 0; x <= w; x += gs) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = 0; y <= h; y += gs) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // Coordinate labels (every 2nd cell).
    ctx.fillStyle = 'rgba(77, 226, 255, 0.4)';
    ctx.font = '10px monospace';
    for (let x = 0; x <= w; x += gs * 2) {
      for (let y = 0; y <= h; y += gs * 2) {
        const lon = ((x / w) * 360 - 180).toFixed(1);
        const lat = ((1 - y / h) * 180 - 90).toFixed(1);
        ctx.fillText(`${lat}°, ${lon}°`, x + 4, y + 12);
      }
    }
  }

  drawWireframeMesh() {
    // O(n) neighbour check via grid index — no more O(n²) pair loop.
    const ctx = this.ctx;
    ctx.lineWidth = 1;

    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        const pt = this.getWaypoint(c, r);
        if (!pt.active && pt.elevation <= 0.1) continue;

        const ptY = pt.y - pt.elevation;

        // Right, bottom, and diagonal neighbours.
        const neighbours = [
          this.getWaypoint(c + 1, r),
          this.getWaypoint(c, r + 1),
          this.getWaypoint(c + 1, r + 1),
        ];

        for (const other of neighbours) {
          if (!other || (!other.active && other.elevation <= 0.1)) continue;
          const dx = pt.x - other.x;
          const dy = ptY - (other.y - other.elevation);
          const dist = Math.sqrt(dx * dx + dy * dy);
          const opacity = Math.max(0.1, 0.5 - dist / (this.gridSize * 2));
          ctx.strokeStyle = `rgba(77, 226, 255, ${opacity})`;
          ctx.beginPath();
          ctx.moveTo(pt.x, ptY);
          ctx.lineTo(other.x, other.y - other.elevation);
          ctx.stroke();
        }
      }
    }
  }

  drawWaypoints() {
    const ctx = this.ctx;
    for (const pt of this.waypoints) {
      if (!pt.active && pt.elevation <= 0.1) continue;
      ctx.save();
      const size = 2 + pt.elevation * 0.3;
      ctx.fillStyle = pt.active ? '#4de2ff' : 'rgba(77, 226, 255, 0.6)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y - pt.elevation, size, 0, Math.PI * 2);
      ctx.fill();

      if (pt.elevation > 1) {
        ctx.strokeStyle = 'rgba(77, 226, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pt.baseX, pt.baseY);
        ctx.lineTo(pt.x, pt.y - pt.elevation);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawRadarScan() {
    const ctx = this.ctx;
    const cx = this.mouse.x;
    const cy = this.mouse.y;

    for (const scan of this.scanLines) {
      scan.length += scan.speed;
      if (scan.length > scan.maxLength) scan.length = 0;

      const endX = cx + Math.cos(scan.angle + this.time * 0.01) * scan.length;
      const endY = cy + Math.sin(scan.angle + this.time * 0.01) * scan.length;

      const grad = ctx.createLinearGradient(cx, cy, endX, endY);
      grad.addColorStop(0, 'rgba(77, 226, 255, 0.4)');
      grad.addColorStop(0.7, 'rgba(77, 226, 255, 0.1)');
      grad.addColorStop(1, 'transparent');

      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }

    // Centre ring
    ctx.strokeStyle = 'rgba(77, 226, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.stroke();

    // Concentric circles — batch into one path per radius to reduce state changes.
    for (let radius = 50; radius <= 200; radius += 50) {
      ctx.strokeStyle = `rgba(77, 226, 255, ${0.3 - radius * 0.001})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawTopographicLines() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const contourSpacing = 40;
    const mouseInfluence = 100;
    const mx = this.mouse.x;
    const t = this.time;

    ctx.strokeStyle = 'rgba(77, 226, 255, 0.1)';
    ctx.lineWidth = 1;

    // Precompute per-x values once, shared across all contour levels.
    const sinCache = new Float32Array(Math.ceil(w / 10) + 1);
    const expCache = new Float32Array(sinCache.length);
    let xi = 0;
    for (let x = 0; x <= w; x += 10, xi++) {
      sinCache[xi] = Math.sin(x * 0.02 + t * 0.05) * 20;
      const d = Math.abs(x - mx);
      expCache[xi] = Math.exp(-d / mouseInfluence) * 30;
    }

    for (let level = 0; level < 10; level++) {
      const base = h / 2 + level * contourSpacing;
      ctx.beginPath();
      let first = true;
      xi = 0;
      for (let x = 0; x <= w; x += 10, xi++) {
        const y = base + sinCache[xi] + expCache[xi];
        if (y >= 0 && y <= h) {
          if (first) { ctx.moveTo(x, y); first = false; }
          else ctx.lineTo(x, y);
        } else {
          first = true;
        }
      }
      ctx.stroke();
    }
  }

  animate() {
    // Schedule next frame first — ensures the loop never stops even if drawing throws.
    requestAnimationFrame(() => this.animate());

    if (this.canvas.width === 0 || this.canvas.height === 0) return;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.time++;

    try {
      this.drawCoordinateGrid();
      this.drawTopographicLines();
      this.updateWaypoints();
      this.drawWireframeMesh();
      this.drawWaypoints();
      this.drawRadarScan();
    } catch (e) {
      console.warn('[Particles] draw error:', e);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('particleCanvas');
  if (canvas) new MappingGrid(canvas);
});
