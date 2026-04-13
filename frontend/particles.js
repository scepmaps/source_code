class MappingGrid {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.gridSize = 60;
    this.time = 0;
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
    this.waypoints = [];
    const cols = Math.ceil(this.canvas.width / this.gridSize) + 1;
    const rows = Math.ceil(this.canvas.height / this.gridSize) + 1;
    
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        this.waypoints.push({
          x: x * this.gridSize,
          y: y * this.gridSize,
          baseX: x * this.gridSize,
          baseY: y * this.gridSize,
          active: false,
          elevation: 0,
          signal: Math.random()
        });
      }
    }
  }
  
  createScanLines() {
    this.scanLines = [];
    for (let i = 0; i < 3; i++) {
      this.scanLines.push({
        angle: (i * 120) * (Math.PI / 180),
        length: 0,
        maxLength: Math.sqrt(this.canvas.width * this.canvas.width + this.canvas.height * this.canvas.height),
        speed: 2 + i * 0.5
      });
    }
  }
  
  bindEvents() {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
  }
  
  updateWaypoints() {
    this.waypoints.forEach(point => {
      const dx = this.mouse.x - point.baseX;
      const dy = this.mouse.y - point.baseY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < this.mouseRadius) {
        const force = (this.mouseRadius - distance) / this.mouseRadius;
        point.elevation = force * 20;
        point.active = true;
        
        // Ripple effect
        const angle = Math.atan2(dy, dx);
        point.x = point.baseX + Math.cos(angle) * force * 15;
        point.y = point.baseY + Math.sin(angle) * force * 15;
      } else {
        point.elevation *= 0.95;
        point.active = distance < this.mouseRadius * 1.5;
        point.x += (point.baseX - point.x) * 0.1;
        point.y += (point.baseY - point.y) * 0.1;
      }
    });
  }
  
  drawCoordinateGrid() {
    this.ctx.strokeStyle = 'rgba(77, 226, 255, 0.15)';
    this.ctx.lineWidth = 0.5;
    
    // Vertical lines
    for (let x = 0; x <= this.canvas.width; x += this.gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.canvas.height);
      this.ctx.stroke();
    }
    
    // Horizontal lines
    for (let y = 0; y <= this.canvas.height; y += this.gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.canvas.width, y);
      this.ctx.stroke();
    }
    
    // Draw coordinate labels
    this.ctx.fillStyle = 'rgba(77, 226, 255, 0.4)';
    this.ctx.font = '10px monospace';
    
    for (let x = 0; x <= this.canvas.width; x += this.gridSize * 2) {
      for (let y = 0; y <= this.canvas.height; y += this.gridSize * 2) {
        const lon = ((x / this.canvas.width) * 360 - 180).toFixed(1);
        const lat = ((1 - y / this.canvas.height) * 180 - 90).toFixed(1);
        this.ctx.fillText(`${lat}°, ${lon}°`, x + 4, y + 12);
      }
    }
  }
  
  drawWireframeMesh() {
    this.ctx.strokeStyle = 'rgba(77, 226, 255, 0.3)';
    this.ctx.lineWidth = 1;
    
    // Connect nearby waypoints to create mesh
    for (let i = 0; i < this.waypoints.length; i++) {
      const point = this.waypoints[i];
      
      for (let j = i + 1; j < this.waypoints.length; j++) {
        const other = this.waypoints[j];
        const dx = point.x - other.x;
        const dy = point.y - other.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < this.gridSize * 1.5 && (point.active || other.active)) {
          const opacity = Math.max(0.1, 0.5 - distance / (this.gridSize * 2));
          this.ctx.strokeStyle = `rgba(77, 226, 255, ${opacity})`;
          this.ctx.beginPath();
          this.ctx.moveTo(point.x, point.y - point.elevation);
          this.ctx.lineTo(other.x, other.y - other.elevation);
          this.ctx.stroke();
        }
      }
    }
  }
  
  drawWaypoints() {
    this.waypoints.forEach(point => {
      if (point.active || point.elevation > 0.1) {
        this.ctx.save();
        
        // Waypoint marker
        const size = 2 + point.elevation * 0.3;
        this.ctx.fillStyle = point.active ? '#4de2ff' : 'rgba(77, 226, 255, 0.6)';
        this.ctx.beginPath();
        this.ctx.arc(point.x, point.y - point.elevation, size, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Elevation indicator
        if (point.elevation > 1) {
          this.ctx.strokeStyle = 'rgba(77, 226, 255, 0.4)';
          this.ctx.lineWidth = 1;
          this.ctx.beginPath();
          this.ctx.moveTo(point.baseX, point.baseY);
          this.ctx.lineTo(point.x, point.y - point.elevation);
          this.ctx.stroke();
        }
        
        this.ctx.restore();
      }
    });
  }
  
  drawRadarScan() {
    this.scanLines.forEach(scan => {
      scan.length += scan.speed;
      if (scan.length > scan.maxLength) scan.length = 0;
      
      const centerX = this.mouse.x;
      const centerY = this.mouse.y;
      const endX = centerX + Math.cos(scan.angle + this.time * 0.01) * scan.length;
      const endY = centerY + Math.sin(scan.angle + this.time * 0.01) * scan.length;
      
      // Radar beam
      const gradient = this.ctx.createLinearGradient(centerX, centerY, endX, endY);
      gradient.addColorStop(0, 'rgba(77, 226, 255, 0.4)');
      gradient.addColorStop(0.7, 'rgba(77, 226, 255, 0.1)');
      gradient.addColorStop(1, 'transparent');
      
      this.ctx.strokeStyle = gradient;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(centerX, centerY);
      this.ctx.lineTo(endX, endY);
      this.ctx.stroke();
    });
    
    // Radar center
    this.ctx.strokeStyle = 'rgba(77, 226, 255, 0.8)';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(this.mouse.x, this.mouse.y, 8, 0, Math.PI * 2);
    this.ctx.stroke();
    
    // Concentric circles
    for (let r = 50; r <= 200; r += 50) {
      this.ctx.strokeStyle = `rgba(77, 226, 255, ${0.3 - r * 0.001})`;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.arc(this.mouse.x, this.mouse.y, r, 0, Math.PI * 2);
      this.ctx.stroke();
    }
  }
  
  drawTopographicLines() {
    // Subtle contour lines that react to mouse
    const contourSpacing = 40;
    const mouseInfluence = 100;
    
    this.ctx.strokeStyle = 'rgba(77, 226, 255, 0.1)';
    this.ctx.lineWidth = 1;
    
    for (let level = 0; level < 10; level++) {
      this.ctx.beginPath();
      let first = true;
      
      for (let x = 0; x <= this.canvas.width; x += 10) {
        const distanceToMouse = Math.abs(x - this.mouse.x);
        const elevation = Math.sin(x * 0.02 + this.time * 0.05) * 20 + 
                        Math.exp(-distanceToMouse / mouseInfluence) * 30;
        const y = this.canvas.height / 2 + level * contourSpacing + elevation;
        
        if (y >= 0 && y <= this.canvas.height) {
          if (first) {
            this.ctx.moveTo(x, y);
            first = false;
          } else {
            this.ctx.lineTo(x, y);
          }
        }
      }
      this.ctx.stroke();
    }
  }
  
  animate() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.time++;
    
    this.drawCoordinateGrid();
    this.drawTopographicLines();
    this.updateWaypoints();
    this.drawWireframeMesh();
    this.drawWaypoints();
    this.drawRadarScan();
    
    requestAnimationFrame(() => this.animate());
  }
}

// Initialize mapping grid system when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('particleCanvas');
  if (canvas) {
    new MappingGrid(canvas);
  }
});
