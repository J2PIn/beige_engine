export class VideoNeutralizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // "level" is continuous 0..4
    this.level = 0;
    this.levelTarget = 0;
    this.mode = "GAME";
    this.lastSpikeAt = 0;

    // crossfade
    this.fade = 1;              // 0..1 blend from A->B
    this.fadeSpeed = 0.035;     // per frame-ish (tuned in step)
    this.switching = false;

    // two video layers for crossfade
    this.videoA = this._makeVideo();
    this.videoB = this._makeVideo();
    this.active = "A";

    this.currentSrc = null;
    this.nextSrc = null;

    // content map
    this.sources = [
      "/assets/video/clouds.mp4",  // level ~0
      "/assets/video/hallway.mp4", // level ~1
      "/assets/video/paint.mp4",   // level ~2
      "/assets/video/wall.mp4",    // level ~3
      "/assets/video/beige.mp4",   // level ~4
    ];

    // Start with something
    this._loadInto(this.videoA, this.sources[0]);
    this.currentSrc = this.sources[0];
  }

  _makeVideo() {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous"; // safe for same-origin assets
    return v;
  }

  setMode(mode) {
    this.mode = mode;
    // Make reset crossfade softer
    this.fadeSpeed = mode === "RESET" ? 0.02 : 0.04;
  }

  spike(nowMs) {
    // Cooldown to avoid rapid thrash
    if (nowMs - this.lastSpikeAt < 600) return;
    this.lastSpikeAt = nowMs;

    if (this.mode === "GAME") this.levelTarget = Math.min(4, this.levelTarget + 1);
    else this.levelTarget = Math.min(4, this.levelTarget + 0.5);
  }

  calm(nowMs) {
    const since = (nowMs - this.lastSpikeAt) / 1000;
    if (since > 5) {
      const decay = this.mode === "GAME" ? 0.02 : 0.01;
      this.levelTarget = Math.max(0, this.levelTarget - decay);
    }
  }

  step(nowMs) {
    // Smoothly move level toward target
    const follow = this.mode === "RESET" ? 0.03 : 0.07;
    this.level += (this.levelTarget - this.level) * follow;

    // choose source based on rounded level buckets
    const idx = Math.max(0, Math.min(4, Math.round(this.level)));
    const desired = this.sources[idx];

    // If desired changed, initiate crossfade
    if (desired && desired !== this.currentSrc && !this.switching) {
      this._beginSwitch(desired);
    }

    // render video with crossfade (fallback if video not ready)
    this._render(nowMs);
  }

  async _loadInto(videoEl, src) {
    try {
      videoEl.src = src;
      // Some browsers need explicit load()
      videoEl.load();
      // Try play; ignore failures (user gesture may be needed)
      await videoEl.play().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async _beginSwitch(nextSrc) {
    this.switching = true;
    this.fade = 0;
    this.nextSrc = nextSrc;

    const target = this.active === "A" ? this.videoB : this.videoA;
    await this._loadInto(target, nextSrc);

    // even if it fails, we still fade (fallback will kick in)
  }

  _drawFallback(nowMs) {
    // Your old procedural beige fallback (minimal)
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;

    ctx.fillStyle = "#f5f5f0";
    ctx.fillRect(0, 0, w, h);

    const t = nowMs / 1000;
    const a = 0.05;
    const gx = (Math.sin(t * 0.05) * 0.5 + 0.5) * w;
    const gy = (Math.cos(t * 0.04) * 0.5 + 0.5) * h;
    const grad = ctx.createRadialGradient(gx, gy, 10, w / 2, h / 2, Math.max(w, h));
    grad.addColorStop(0, `rgba(220,218,207,${a})`);
    grad.addColorStop(1, `rgba(245,245,240,0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  _isReady(v) {
    return v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0;
  }

  _drawCover(videoEl) {
    const ctx = this.ctx;
    const { width: cw, height: ch } = this.canvas;

    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;

    // cover crop
    const canvasAspect = cw / ch;
    const videoAspect = vw / vh;

    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (videoAspect > canvasAspect) {
      // video wider -> crop sides
      sh = vh;
      sw = vh * canvasAspect;
      sx = (vw - sw) / 2;
    } else {
      // video taller -> crop top/bottom
      sw = vw;
      sh = vw / canvasAspect;
      sy = (vh - sh) / 2;
    }

    ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, cw, ch);
  }

  _render(nowMs) {
    const ctx = this.ctx;

    const A = this.videoA;
    const B = this.videoB;

    const activeVid = this.active === "A" ? A : B;
    const otherVid = this.active === "A" ? B : A;

    const activeReady = this._isReady(activeVid);
    const otherReady = this._isReady(otherVid);

    // If nothing is ready, fallback
    if (!activeReady && !otherReady) {
      this._drawFallback(nowMs);
      return;
    }

    if (!this.switching) {
      // Just draw the active video
      if (activeReady) this._drawCover(activeVid);
      else this._drawCover(otherVid);
      return;
    }

    // During switching: crossfade A->B (active->other)
    // Ensure we draw both if possible
    ctx.save();

    if (activeReady) {
      ctx.globalAlpha = 1;
      this._drawCover(activeVid);
    } else {
      // active not ready: draw fallback base
      this._drawFallback(nowMs);
    }

    // fade in other
    const t = this.fade;
    const eased = t * t * (3 - 2 * t); // smoothstep
    ctx.globalAlpha = eased;
    if (otherReady) this._drawCover(otherVid);

    ctx.restore();

    // advance fade
    this.fade = Math.min(1, this.fade + this.fadeSpeed);

    // complete switch when fully faded
    if (this.fade >= 1) {
      this.switching = false;
      this.currentSrc = this.nextSrc;
      this.nextSrc = null;
      this.active = this.active === "A" ? "B" : "A";
    }
  }
}
