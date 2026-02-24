console.log("BORING MVP: main.js loaded");
document.getElementById("status").textContent = "status: script loaded";
import { RollingStats, computeArousal, clamp01 } from "./arousal.js";
import { Neutralizer } from "./neutralization.js";

// --- Canvas sizing ---
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
function resize() {
  canvas.width = Math.floor(window.innerWidth * devicePixelRatio);
  canvas.height = Math.floor(window.innerHeight * devicePixelRatio);
}
window.addEventListener("resize", resize);
resize();

// --- HUD elements ---
const statusEl = document.getElementById("status");
const metricsEl = document.getElementById("metrics");
const timerEl = document.getElementById("timer");
const startBtn = document.getElementById("startBtn");
const modeBtn = document.getElementById("modeBtn");
const calBtn = document.getElementById("calBtn");
const reset10Btn = document.getElementById("reset10Btn");

const video = document.getElementById("video");

// --- Neutralizer ---
const neutralizer = new Neutralizer(canvas);

// --- Rolling stats ---
const gazeXStats = new RollingStats(180); // ~3s at 60fps
const gazeYStats = new RollingStats(180);
const arousalBaseline = new RollingStats(600); // ~10s baseline

let running = false;
let mode = "GAME";
let calibrated = false;
let calibratingUntil = 0;

let prevT = performance.now();
let prevGX = 0.5, prevGY = 0.5;

let resetUntil = 0;

// --- MediaPipe FaceMesh via CDN (ESM) ---
import vision from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

let faceLandmarker = null;
let lastLandmarks = null;

async function initFaceMesh() {
  statusEl.textContent = "status: loading face model…";
  const filesetResolver = await vision.FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    },
    outputFaceBlendshapes: false,
    runningMode: "VIDEO",
    numFaces: 1,
  });
  statusEl.textContent = "status: model loaded";
}

async function initCamera() {
  statusEl.textContent = "status: requesting camera…";
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
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

      // Spike logic (different sensitivity per mode)
      const mult = mode === "GAME" ? 1.15 : 1.10;
      const spike = arousal > base * mult;

      if (spike) neutralizer.spike(now);
      else neutralizer.calm(now);

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

  requestAnimationFrame(tick);
}

// --- UI wiring ---
startBtn.onclick = async () => {
  if (running) return;
  try {
    await initFaceMesh();
    await initCamera();
    running = true;
    beginCalibration(10);
    requestAnimationFrame(tick);
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
