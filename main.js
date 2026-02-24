import { RollingStats, computeArousal, clamp01 } from "./arousal.js";
import { Neutralizer } from "./neutralization.js";

console.log("BORING MVP: main.js loaded");
document.getElementById("status").textContent = "status: script loaded";

// --- Canvas sizing ---
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
function resize() {
  canvas.width = Math.floor(window.innerWidth * devicePixelRatio);
  canvas.height = Math.floor(window.innerHeight * devicePixelRatio);
}
window.addEventListener("resize", resize);
resize();

let FilesetResolverRef = null;
let FaceLandmarkerRef = null;

async function makeShareCardBlob() {
  // Create offscreen card
  const w = 1080, h = 1920;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");

  // Background: current boring frame
  // Draw the live canvas scaled to fill
  const src = canvas;
  g.drawImage(src, 0, 0, w, h);

  // Soft overlay for readability
  g.fillStyle = "rgba(255,255,255,0.75)";
  g.fillRect(60, 120, w - 120, 520);

  g.fillStyle = "rgba(0,0,0,0.85)";
  g.font = "bold 56px ui-sans-serif, system-ui";
  g.fillText("BORING.AI (MVP)", 90, 200);

  g.font = "28px ui-sans-serif, system-ui";
  const lines = [
    `Mode: ${session?.mode ?? mode}`,
    `Duration: ${Math.floor((session?.durationMs ?? 0)/1000)}s`,
    `First spike: ${session?.tFirstSpikeMs == null ? "none" : Math.floor(session.tFirstSpikeMs/1000) + "s"}`,
    `Spikes: ${session?.spikes ?? 0}`,
    `Avg arousal: ${(session?.avgArousal ?? 0).toFixed(3)}`,
    `Max level: ${(session?.maxLevel ?? 0).toFixed(2)}`,
    "",
    "If you get excited, you lose.",
    "beige-engine.pages.dev",
  ];
  let y = 260;
  for (const line of lines) {
    g.fillText(line, 90, y);
    y += 46;
  }

  return await new Promise((resolve) => {
    c.toBlob((b) => resolve(b), "image/png", 0.92);
  });
}




// --- HUD elements ---
const statusEl = document.getElementById("status");
const metricsEl = document.getElementById("metrics");
const timerEl = document.getElementById("timer");
const startBtn = document.getElementById("startBtn");
const modeBtn = document.getElementById("modeBtn");
const calBtn = document.getElementById("calBtn");
const reset10Btn = document.getElementById("reset10Btn");
const copyBtn = document.getElementById("copyBtn");

const video = document.getElementById("video");

// --- NEW: session buttons ---
const stopBtn = document.getElementById("stopBtn");
const shareBtn = document.getElementById("shareBtn");
const dlBtn = document.getElementById("dlBtn");
const resultEl = document.getElementById("result");
if (!stopBtn || !shareBtn || !dlBtn || !resultEl) {
  console.warn("Missing session UI elements", { stopBtn, shareBtn, dlBtn, resultEl });
}

// --- NEW: session state ---
let session = null;
let sessionStart = 0;
let lastArousal = 0;
let maxArousal = 0;
let arousalSum = 0;
let arousalN = 0;
let spikeTotal = 0;
let firstSpikeAt = null;
let maxLevel = 0;

let lastCardBlob = null;
let cameraStream = null;
let rafId = null;
let spikeState = false;

// --- Neutralizer ---
const spikeEl = document.getElementById("spike");
let spikeUntil = 0;
let spikeCount = 0;
const neutralizer = new Neutralizer(canvas);

// --- Rolling stats ---
const gazeXStats = new RollingStats(180); // ~3s at 60fps
const gazeYStats = new RollingStats(180);
const arousalBaseline = new RollingStats(600); // ~10s baseline

let running = false;
function setStartUi(isRunning) {
  startBtn.disabled = isRunning;
  startBtn.textContent = isRunning ? "Running…" : "Start";
}
let mode = "GAME";
let calibrated = false;
let calibratingUntil = 0;

let prevT = performance.now();
let prevGX = 0.5, prevGY = 0.5;

let resetUntil = 0;

// --- MediaPipe FaceMesh via CDN (ESM) ---

let faceLandmarker = null;
let lastLandmarks = null;

async function initFaceMesh() {
  statusEl.textContent = "status: loading face model…";

  if (!FilesetResolverRef || !FaceLandmarkerRef) {
    const mp = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
    FilesetResolverRef = mp.FilesetResolver;
    FaceLandmarkerRef = mp.FaceLandmarker;
  }

  const filesetResolver = await FilesetResolverRef.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  faceLandmarker = await FaceLandmarkerRef.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    },
    runningMode: "VIDEO",
    numFaces: 1,
  });

  statusEl.textContent = "status: model loaded";
  }
  async function initCamera() {
    statusEl.textContent = "status: requesting camera…";
    cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = cameraStream;
  await video.play();
  statusEl.textContent = "status: camera active";
}

// Eye landmark indices (MediaPipe Face Mesh):
// We'll use iris centers if available. Iris landmarks:
// Left iris: 468..472, Right iris: 473..477 (in classic FaceMesh).
// FaceLandmarker provides 478-ish points similarly.
function avgPoint(landmarks, idxs) {
  let x=0,y=0;
  for (const i of idxs) { x += landmarks[i].x; y += landmarks[i].y; }
  return { x: x/idxs.length, y: y/idxs.length };
}

function computeGazeProxy(landmarks) {
  // Iris centers (normalized coordinates in [0..1] relative to image)
  const L = avgPoint(landmarks, [468,469,470,471,472]);
  const R = avgPoint(landmarks, [473,474,475,476,477]);
  const gx = (L.x + R.x) / 2;
  const gy = (L.y + R.y) / 2;

  // Map from camera-space to “screen fraction” (still 0..1)
  return { gx: clamp01(gx), gy: clamp01(gy) };
}

function beginCalibration(seconds = 10) {
  calibrated = false;
  arousalBaseline.values = []; arousalBaseline.sum = 0; arousalBaseline.sumSq = 0;
  calibratingUntil = performance.now() + seconds * 1000;
  statusEl.textContent = `status: calibrating baseline (${seconds}s)…`;
}

function setMode(newMode) {
  mode = newMode;
  neutralizer.setMode(newMode);
  modeBtn.textContent = `Mode: ${newMode}`;
}

function startReset10() {
  // 10 min
  resetUntil = performance.now() + 10 * 60 * 1000;
  setMode("RESET");
  beginCalibration(8); // shorter calibration for reset
}

function formatMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2,"0");
  const ss = String(s % 60).padStart(2,"0");
  return `${mm}:${ss}`;
}

function sessionToQuery(s) {
  const p = new URLSearchParams();
  p.set("d", String(Math.floor(s.durationMs / 1000)));
  p.set("fs", s.tFirstSpikeMs == null ? "none" : String(Math.floor(s.tFirstSpikeMs / 1000)));
  p.set("sp", String(s.spikes));
  p.set("al", s.avgArousal.toFixed(3));
  p.set("ml", s.maxLevel.toFixed(2));
  p.set("m", s.mode);
  return p.toString();
}

function getShareUrl() {
  const base = location.origin + location.pathname;
  return `${base}?${sessionToQuery(session)}`;
}

async function tick() {
  if (!running) return;

  const now = performance.now();
  const dtSec = (now - prevT) / 1000;
  prevT = now;

  // Render boring content continuously
  neutralizer.step(now);

  // Run face landmark detection
  if (faceLandmarker && video.readyState >= 2) {
    const res = faceLandmarker.detectForVideo(video, now);
    if (res?.faceLandmarks?.length) {
      lastLandmarks = res.faceLandmarks[0];
    }
  }

  if (lastLandmarks) {
    const { gx, gy } = computeGazeProxy(lastLandmarks);

    // Rolling stats for scan variance
    gazeXStats.push(gx);
    gazeYStats.push(gy);

    const varX = gazeXStats.variance();
    const varY = gazeYStats.variance();

    const { arousal } = computeArousal({
      gazeX: gx, gazeY: gy,
      prevX: prevGX, prevY: prevGY,
      dtSec, varX, varY
    });

    prevGX = gx; prevGY = gy;

    // Calibration / baseline
    if (!calibrated) {
      arousalBaseline.push(arousal);
      if (now >= calibratingUntil) {
        calibrated = true;
        statusEl.textContent = "status: running";
      }
    } else {
      // Keep a slow-updating baseline
      arousalBaseline.push(arousal);
      const base = Math.max(0.0001, arousalBaseline.mean());

      // --- session stats ---
      lastArousal = arousal;
      maxArousal = Math.max(maxArousal, arousal);
      arousalSum += arousal;
      arousalN += 1;
      maxLevel = Math.max(maxLevel, neutralizer.level);

      // Spike logic (different sensitivity per mode)
      const mult = mode === "GAME" ? 1.15 : 1.10;
      const spikeRaw = arousal > base * mult;
      
      // Require spike to persist briefly (~150ms) to avoid jitter
      if (spikeRaw) spikeCount++;
      else spikeCount = Math.max(0, spikeCount - 1);
      
      const spike = spikeCount >= 8; // ~8 frames ≈ 130–160ms depending on fps
      const prevSpikeState = spikeState;
      spikeState = spike;
      
      if (spike && !prevSpikeState) {
        spikeTotal += 1;
        if (firstSpikeAt === null) firstSpikeAt = now;
        neutralizer.spike(now);
        spikeUntil = now + 350;
      } else if (!spike) {
        neutralizer.calm(now);
      }
      
      if (spike) {
        spikeTotal += 1;
        if (firstSpikeAt === null) firstSpikeAt = now;
      
        neutralizer.spike(now);
        spikeUntil = now + 350;
      } else {
        neutralizer.calm(now);
      }

      metricsEl.textContent =
        `arousal: ${arousal.toFixed(3)} | baseline: ${base.toFixed(3)} | level: ${neutralizer.level.toFixed(2)} | mode: ${mode}`;
    }
  } else {
    metricsEl.textContent = "arousal: - | baseline: - | level: -";
    if (running) statusEl.textContent = "status: face not detected";
  }

  // Reset timer UI
  if (mode === "RESET") {
    const left = resetUntil - now;
    timerEl.textContent = left > 0 ? `RESET left: ${formatMs(left)}` : "RESET complete";
    if (left <= 0) {
      // end reset
      resetUntil = 0;
      setMode("GAME");
      beginCalibration(10);
    }
  } else {
    timerEl.textContent = "";
  }
  spikeEl.style.opacity = now < spikeUntil ? "1" : "0";
  rafId = requestAnimationFrame(tick);
}
function stopRun() {
  running = false;
  calibrated = false;
  lastLandmarks = null;

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }

  if (video) video.srcObject = null;

  setStartUi(false);
  statusEl.textContent = "status: idle";
}

// --- UI wiring ---
startBtn.onclick = async () => {
  if (running) return;
  setStartUi(true);
  try {
    await initFaceMesh();
    await initCamera();
    running = true;
    sessionStart = performance.now();
    lastArousal = 0;
    maxArousal = 0;
    arousalSum = 0;
    arousalN = 0;
    spikeTotal = 0;
    firstSpikeAt = null;
    maxLevel = 0;
    lastCardBlob = null;
    
    resultEl.textContent = "";
    shareBtn.disabled = true;
    dlBtn.disabled = true;
    setStartUi(true);
    beginCalibration(10);
    rafId = requestAnimationFrame(tick);
  } catch (e) {
    console.error(e);
    statusEl.textContent = `status: error (${e?.message || e})`;
  }
};

modeBtn.onclick = () => {
  if (mode === "GAME") setMode("RESET");
  else setMode("GAME");
  beginCalibration(mode === "RESET" ? 8 : 10);
};

calBtn.onclick = () => beginCalibration(mode === "RESET" ? 8 : 10);

reset10Btn.onclick = () => startReset10();

function endSession() {
  const now = performance.now();
  const durationMs = now - sessionStart;
  const avgArousal = arousalN ? (arousalSum / arousalN) : 0;
  const tFirstSpike = firstSpikeAt ? (firstSpikeAt - sessionStart) : null;

  session = {
    endedAt: Date.now(),
    mode,
    durationMs,
    spikes: spikeTotal,
    avgArousal,
    maxArousal,
    maxLevel,
    tFirstSpikeMs: tFirstSpike,
  };

  // best run (by duration without spike, fallback duration)
  const score = tFirstSpike ?? durationMs;
  const prev = JSON.parse(localStorage.getItem("beige_best") || "null");
  if (!prev || score > (prev.tFirstSpikeMs ?? prev.durationMs)) {
    localStorage.setItem("beige_best", JSON.stringify(session));
  }

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2,"0");
    const ss = String(s % 60).padStart(2,"0");
    return `${mm}:${ss}`;
  };

  resultEl.innerHTML =
    `<b>Session complete</b><br>` +
    `Mode: ${session.mode}<br>` +
    `Duration: ${fmt(session.durationMs)}<br>` +
    `Time to first spike: ${session.tFirstSpikeMs == null ? "none" : fmt(session.tFirstSpikeMs)}<br>` +
    `Spikes: ${session.spikes}<br>` +
    `Avg arousal: ${session.avgArousal.toFixed(3)}<br>` +
    `Max level: ${session.maxLevel.toFixed(2)}<br>`;

  shareBtn.disabled = false;
  dlBtn.disabled = false;
}

stopBtn.onclick = () => {
  if (!running) return;
  endSession();
  stopRun();
};
if (dlBtn) dlBtn.onclick = async () => {
  if (!session) endSession();
  if (!lastCardBlob) lastCardBlob = await makeShareCardBlob();
  const url = URL.createObjectURL(lastCardBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "boring-ai-session.png";
  a.click();
  URL.revokeObjectURL(url);
};

if (shareBtn) shareBtn.onclick = async () => {
  if (!session) endSession();
  if (!lastCardBlob) lastCardBlob = await makeShareCardBlob();

  const file = new File([lastCardBlob], "boring-ai-session.png", { type: "image/png" });
  const text = `I tried to reach maximum boredom. Time to first spike: ${
    session.tFirstSpikeMs == null ? "none" : Math.floor(session.tFirstSpikeMs/1000) + "s"
  }.`;

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ title: "BORING.AI", text, files: [file] });
  } else {
    // fallback: download
    dlBtn?.click();
  }
};
