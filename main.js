// Beige Engine — camera diagnostic build. No backend; no camera frames uploaded.
import { measureFeatures, movementScore, MOTION_THRESHOLD } from './gaze.js';

const $=id=>document.getElementById(id);
const names=['Clouds','Hallway','Wall','Paint','Beige'];
const fallbackColors=['#c4c7c2','#bcb8a9','#aaa69a','#9d9585','#908778'];
const paths=['clouds','hallway','wall','paint','beige'].map(name=>`./assets/video/${name}.mp4`);
const videos=names.map((_,i)=>$('v'+i));
videos.forEach((video,i)=>{ video.src=paths[i]; video.muted=true; video.loop=true; video.playsInline=true; });

const game=$('game'),reset=$('reset'),stop=$('stop'),camera=$('camera'),status=$('status'),result=$('result'),sensor=$('sensor');
let active=false,preparing=false,mode='GAME',remaining=60,started=0,deadline=0,streakStart=0,bestStreak=0,incidents=0,level=0,lastIncident=-Infinity,raf=0;
let cameraStream=null,faceModel=null,camVideo=null,lastFeatures=null,lastDetectedAt=0,trackedFrames=0,frameCanvas=null,frameCtx=null,compatMode=false;
let lastResult='',lastPointer=null,pointerDistance=0,pointerWindow=0;

function msg(value){status.textContent=value}
function sensorMsg(value){sensor.textContent=value}
function setStage(index){
  const i=Math.max(0,Math.min(4,index));
  videos.forEach((video,n)=>{
    video.classList.toggle('active',n===i);
    if(n!==i&&!video.paused)video.pause();
  });
  $('stageTitle').textContent=names[i];
  $('screen').style.background=fallbackColors[i];
  $('stageIndex').textContent=`STAGE ${String(i+1).padStart(2,'0')} / 05`;
  $('progress').style.width=`${i*25}%`;
  $('pct').textContent=`${i*25}%`;
  $('screenCaption').textContent=i===4?'NEUTRALIZATION ACHIEVED':'PLEASE REMAIN UNIMPRESSED';
  if(videos[i].paused) videos[i].play().catch(()=>{});
}
function durationFormat(sec){
  const n=Math.max(0,Math.ceil(sec));
  return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
}
function incident(now){
  if(!active||now-lastIncident<1450)return;
  bestStreak=Math.max(bestStreak,(now-streakStart)/1000);
  streakStart=now;
  lastIncident=now;
  incidents++;
  level=Math.min(4,level+1);
  setStage(level);
  $('spikes').textContent=String(incidents);
  msg(level>=4?'All remaining stimulation has been administratively removed.':'Movement incident detected. Appropriate action taken.');
}
function pointerMove(event){
  if(!active||cameraStream)return;
  const x=event.clientX??0,y=event.clientY??0,now=performance.now();
  if(lastPointer)pointerDistance+=Math.hypot(x-lastPointer.x,y-lastPointer.y);
  lastPointer={x,y};
  if(pointerDistance>180){incident(now);pointerDistance=0;pointerWindow=now}
  else if(now-pointerWindow>850){pointerDistance=0;pointerWindow=now}
}
window.addEventListener('pointermove',pointerMove,{passive:true});
window.addEventListener('touchmove',()=>{if(active&&!cameraStream)incident(performance.now())},{passive:true});

async function setupCamera(){
  // IMPORTANT: finish loading the camera before starting the game timer.
  let stream=null,model=null;
  try{
    sensorMsg('Webcam: loading the local face-tracking model…');
    const mp=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
    const fs=await mp.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    model=await mp.FaceLandmarker.createFromOptions(fs,{
      baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'},
      runningMode:'VIDEO',numFaces:1
    });
    sensorMsg('Webcam: requesting camera permission…');
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640}},audio:false});
    camVideo=document.createElement('video');
    camVideo.muted=true;
    camVideo.playsInline=true;
    camVideo.autoplay=true;
    camVideo.srcObject=stream;
    await camVideo.play();
    cameraStream=stream;
    faceModel=model;
    lastFeatures=null;
    lastDetectedAt=0;
    trackedFrames=0;
    frameCanvas=null;
    frameCtx=null;
    compatMode=false;
    sensorMsg('Webcam: connected · looking for a face…');
    return true;
  }catch(error){
    stream?.getTracks().forEach(track=>track.stop());
    model?.close?.();
    if(camVideo){camVideo.srcObject=null;camVideo=null}
    camera.checked=false;
    sensorMsg('Webcam unavailable; using pointer/touch. See browser camera permissions.');
    console.warn('Camera setup:',error);
    return false;
  }
}
function cleanupCamera(){
  cameraStream?.getTracks().forEach(track=>track.stop());
  cameraStream=null;
  faceModel?.close?.();
  faceModel=null;
  if(camVideo){camVideo.pause();camVideo.srcObject=null;camVideo=null}
  lastFeatures=null;
  frameCanvas=null;
  frameCtx=null;
  compatMode=false;
}
function shortError(error){
  return String(error?.message||error||'Unknown camera error').replace(/\s+/g,' ').slice(0,155);
}
function detectViaCanvas(now){
  if(!frameCanvas){
    frameCanvas=document.createElement('canvas');
    frameCtx=frameCanvas.getContext('2d',{willReadFrequently:true});
    if(!frameCtx)throw new Error('Canvas 2D context unavailable');
  }
  // Canvas, video, and face landmarks all stay inside this browser session.
  frameCanvas.width=camVideo.videoWidth;
  frameCanvas.height=camVideo.videoHeight;
  frameCtx.drawImage(camVideo,0,0,frameCanvas.width,frameCanvas.height);
  return faceModel.detectForVideo(frameCanvas,now);
}
function detectGaze(now){
  if(!faceModel||!camVideo||now-lastDetectedAt<120)return;
  if(camVideo.readyState<2||camVideo.videoWidth<2||camVideo.videoHeight<2){
    sensorMsg(`Webcam: waiting for a valid frame (ready ${camVideo.readyState}; ${camVideo.videoWidth}×${camVideo.videoHeight})`);
    return;
  }
  lastDetectedAt=now;
  let response;
  try{
    response=compatMode?detectViaCanvas(now):faceModel.detectForVideo(camVideo,now);
  }catch(firstError){
    if(compatMode){
      console.warn('Camera canvas frame:',firstError);
      sensorMsg(`Webcam failed: ${shortError(firstError)}. Switching to pointer/touch.`);
      cleanupCamera();
      camera.checked=false;
      return;
    }
    console.warn('Camera video frame:',firstError);
    try{
      response=detectViaCanvas(now);
      compatMode=true;
    }catch(secondError){
      console.warn('Camera canvas fallback:',secondError);
      sensorMsg(`Webcam video: ${shortError(firstError)}. Canvas: ${shortError(secondError)}. Switched to pointer/touch.`);
      cleanupCamera();
      camera.checked=false;
      return;
    }
  }
  const features=measureFeatures(response?.faceLandmarks?.[0]);
  if(!features){
    lastFeatures=null;
    sensorMsg('Webcam connected, but face not tracked. Face camera in even lighting.');
    return;
  }
  trackedFrames++;
  const score=movementScore(features,lastFeatures);
  lastFeatures=features;
  sensorMsg(`Webcam: face tracked${compatMode?' (canvas mode)':''} · frames ${trackedFrames} · movement ${score.toFixed(3)} / ${MOTION_THRESHOLD.toFixed(3)}. Look LEFT ↔ RIGHT.`);
  if(trackedFrames>2&&score>=MOTION_THRESHOLD)incident(now);
}
function tick(now){
  if(!active)return;
  remaining=Math.max(0,(deadline-now)/1000);
  $('time').textContent=durationFormat(remaining);
  bestStreak=Math.max(bestStreak,(now-streakStart)/1000);
  $('score').textContent=`${Math.floor((now-streakStart)/1000)}s`;
  if(cameraStream)detectGaze(now);
  if(remaining<=0){finish('complete');return}
  raf=requestAnimationFrame(tick);
}
async function startSession(type){
  if(active||preparing)return;
  preparing=true;
  game.disabled=true;
  reset.disabled=true;
  camera.disabled=true;
  $('liveStatus').textContent='PREPARING';
  if(camera.checked) await setupCamera();
  preparing=false;
  active=true;
  mode=type;
  remaining=type==='GAME'?60:600;
  started=performance.now();
  deadline=started+remaining*1000;
  streakStart=started;
  bestStreak=0;
  incidents=0;
  level=0;
  lastIncident=-Infinity;
  lastPointer=null;
  pointerDistance=0;
  pointerWindow=started;
  setStage(0);
  $('time').textContent=durationFormat(remaining);
  $('spikes').textContent='0';
  $('score').textContent='0s';
  result.classList.remove('show');
  stop.disabled=false;
  $('liveStatus').textContent='ACTIVE';
  if(!cameraStream&&camera.checked===false&&sensor.textContent.indexOf('unavailable')<0)
    sensorMsg('Input: pointer/touch · move around the screen to trigger stages.');
  msg(type==='GAME'?'One-minute movement game underway.':'Ten-minute quiet session underway.');
  raf=requestAnimationFrame(tick);
}
function finish(reason){
  if(!active)return;
  const now=performance.now();
  active=false;
  cancelAnimationFrame(raf);
  const wasCamera=!!cameraStream;
  cleanupCamera();
  game.disabled=false;
  reset.disabled=false;
  stop.disabled=true;
  camera.disabled=false;
  $('liveStatus').textContent='COMPLETE';
  const total=(now-started)/1000;
  const finalStreak=Math.max(0,(now-streakStart)/1000);
  bestStreak=Math.max(bestStreak,finalStreak);
  const label=reason==='complete'?'Completed':'Ended early';
  $('resultTitle').textContent=incidents===0?'Officially unremarkable.':'Some movement was detected.';
  $('resultText').textContent=`${label}: ${durationFormat(total)} · Incidents: ${incidents} · Longest quiet streak: ${Math.floor(bestStreak)}s · Final stage: ${names[level]}.`;
  lastResult=`I tried Beige Engine: ${durationFormat(total)}, ${incidents} movement incident(s), ${Math.floor(bestStreak)}s longest quiet streak. ${names[level]} stage. https://beigengine.app/`;
  result.classList.add('show');
  sensorMsg(wasCamera?'Webcam session ended · camera stopped.':'Pointer/touch session ended.');
  msg('Assessment complete. Your mediocrity has been logged locally only.');
  try{localStorage.setItem('beige_best_streak',String(Math.max(+localStorage.getItem('beige_best_streak')||0,bestStreak)))}catch{}
}

game.addEventListener('click',()=>startSession('GAME'));
reset.addEventListener('click',()=>startSession('RESET'));
stop.addEventListener('click',()=>finish('ended'));
$('share').addEventListener('click',async()=>{
  if(navigator.share){
    try{await navigator.share({title:'Beige Engine',text:lastResult,url:'https://beigengine.app/'});return}
    catch(error){if(error.name==='AbortError')return}
  }
  await copyResult();
});
async function copyResult(){
  try{await navigator.clipboard.writeText(lastResult);msg('Result copied. Please share without enthusiasm.')}
  catch{msg('Copy unavailable; select the result text above.')}
}
$('copy').addEventListener('click',copyResult);
window.addEventListener('pagehide',()=>{if(active)finish('ended');else cleanupCamera()});
setStage(0);
videos[0].play().catch(()=>{});
