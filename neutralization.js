export class Neutralizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.level = 0;
    this.levelTarget = 0;
    this.mode = "GAME"; // or "RESET"
    this.lastSpikeAt = 0;
  }

  setMode(mode) {
    this.mode = mode;
  }

  spike(nowMs) {
    this.lastSpikeAt = nowMs;
    if (this.mode === "GAME") {
      this.levelTarget = Math.min(4, this.levelTarget + 1);
    } else {
      // RESET: damp more gently
      this.levelTarget = Math.min(4, this.levelTarget + 0.5);
    }
  }

  calm(nowMs) {
    // slowly decay level target if stable
    const since = (nowMs - this.lastSpikeAt) / 1000;
    if (since > 5) {
      const decay = this.mode === "GAME" ? 0.02 : 0.01;
      this.levelTarget = Math.max(0, this.levelTarget - decay);
    }
  }

  step(nowMs) {
    // smooth-follow target
    const follow = this.mode === "GAME" ? 0.08 : 0.04;
    this.level += (this.levelTarget - this.level) * follow;

    // render
    this.render(nowMs);
  }

  render(nowMs) {
    const { width:w, height:h } = this.canvas;
    const ctx = this.ctx;

    // Base beige
    ctx.fillStyle = "#f5f5f0";
    ctx.fillRect(0,0,w,h);

    // Level-specific: more boring as level increases
    const lvl = this.level;

    // (0) very slow cloud-like gradient drift
    if (lvl < 1) {
      const t = nowMs / 1000;
      const a = 0.06 * (1 - lvl);
      const gx = (Math.sin(t * 0.05) * 0.5 + 0.5) * w;
      const gy = (Math.cos(t * 0.04) * 0.5 + 0.5) * h;
      const grad = ctx.createRadialGradient(gx, gy, 10, w/2, h/2, Math.max(w,h));
      grad.addColorStop(0, `rgba(220,218,207,${a})`);
      grad.addColorStop(1, `rgba(245,245,240,0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0,0,w,h);
    }

    // (1-2) add faint texture
    if (lvl >= 0.8) {
      const t = nowMs / 1000;
      const alpha = Math.min(0.08, 0.03 + (lvl-0.8)*0.04);
      const step = lvl < 2 ? 6 : 10;
      ctx.fillStyle = `rgba(210,208,199,${alpha})`;
      for (let y=0; y<h; y+=step) {
        const xOff = Math.sin((y*0.01) + t*0.2) * 6;
        ctx.fillRect((w/2)+xOff - 60, y, 120, 1);
      }
    }

    // (3) almost imperceptible color fade
    if (lvl >= 2.7) {
      const t = nowMs / 1000;
      const k = (Math.sin(t * 0.02) * 0.5 + 0.5);
      ctx.fillStyle = `rgba(234,232,226,${0.10 + 0.10*(lvl-2.7)})`;
      ctx.fillRect(0,0,w,h);
      ctx.fillStyle = `rgba(245,245,240,${0.12*k})`;
      ctx.fillRect(0,0,w,h);
    }

    // (4) near-static grain (still boring but “dead”)
    if (lvl >= 3.6) {
      const alpha = Math.min(0.06, 0.02 + (lvl-3.6)*0.05);
      const img = ctx.getImageData(0,0,w,h);
      const data = img.data;
      // light grain: sample only a subset of pixels (fast enough)
      for (let i=0; i<data.length; i+=4*24) {
        const n = (Math.random()*2-1) * 8; // tiny
        data[i] = Math.min(255, Math.max(0, data[i] + n));
        data[i+1] = Math.min(255, Math.max(0, data[i+1] + n));
        data[i+2] = Math.min(255, Math.max(0, data[i+2] + n));
      }
      ctx.putImageData(img,0,0);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillRect(0,0,w,h);
    }
  }
}
