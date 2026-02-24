export class RollingStats {
  constructor(maxLen = 300) {
    this.maxLen = maxLen;
    this.values = [];
    this.sum = 0;
    this.sumSq = 0;
  }
  push(x) {
    this.values.push(x);
    this.sum += x;
    this.sumSq += x * x;
    if (this.values.length > this.maxLen) {
      const y = this.values.shift();
      this.sum -= y;
      this.sumSq -= y * y;
    }
  }
  mean() {
    return this.values.length ? this.sum / this.values.length : 0;
  }
  variance() {
    const n = this.values.length;
    if (n < 2) return 0;
    const m = this.mean();
    return Math.max(0, (this.sumSq / n) - (m * m));
  }
}

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Arousal index from gaze movement:
 * - velocity: distance moved since last frame
 * - scan variance: rolling variance of gaze X/Y (combined)
 */
export function computeArousal({
  gazeX, gazeY,
  prevX, prevY,
  dtSec,
  varX, varY
}) {
  const dx = gazeX - prevX;
  const dy = gazeY - prevY;
  const dist = Math.sqrt(dx*dx + dy*dy);

  // velocity in "screen fraction per second"
  const vel = dtSec > 0 ? dist / dtSec : 0;

  // normalize (hand-tuned for browser noise)
  const velN = clamp01(vel / 1.2);          // ~0..1
  const varN = clamp01(((varX + varY) / 2) / 0.0025);

  // weighted sum
  const arousal = clamp01(velN * 0.65 + varN * 0.35);
  return { arousal, velN, varN };
}
