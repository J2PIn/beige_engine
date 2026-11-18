// Beige Engine — launch-hardening candidate. No backend; no image/video upload.
import { RollingStats, computeArousal } from './arousal.js';
const $=id=>document.getElementById(id), names=['Clouds','Hallway','Wall','Paint','Beige'];
const fallbackColors=['#c4c7c2','#bcb8a9','#aaa69a','#9d9585','#908778'];
const paths=['clouds','hallway','wall','paint','beige'].map(name=>`./assets/video/${name}.mp4`);
const els=names.map((_,i)=>$('v'+i)); els.forEach((v,i)=>{v.src=paths[i];v.muted=true;v.loop=true;v.playsInline=true;});
const game=$('game'),reset=$('reset'),stop=$('stop'),camera=$('camera'),status=$('status'),result=$('result');
let active=false,mode='GAME',remaining=60,started=0,deadline=0,streakStart=0,bestStreak=0,incidents=0,level=0,lastIncident=-Infinity,lastActivity=0,raf=0,lastFrame=0;
let cameraStream=null,faceModel=null,camVideo=null, lastGaze=null, lastDetectedAt=0, gazeStatsX=new RollingStats(40),gazeStatsY=new RollingStats(40), baseline=new RollingStats(40),lastGazeClock=0;
let lastResult=''; let lastPointer=null, pointerDistance=0, pointerWindow=0;
function msg(t){status.textContent=t}
function setStage(i){i=Math.max(0,Math.min(4,i));els.forEach((v,n)=>{v.classList.toggle('active',n===i);if(n!==i&&!v.paused)v.pause();});$('stageTitle').textContent=names[i];$('screen').style.background=fallbackColors[i];$('stageIndex').textContent=`STAGE ${String(i+1).padStart(2,'0')} / 05`;$('progress').style.width=`${i*25}%`;$('pct').textContent=`${i*25}%`;$('screenCaption').textContent=i===4?'NEUTRALIZATION ACHIEVED':'PLEASE REMAIN UNIMPRESSED'; if(els[i].paused){els[i].play().catch(()=>{});}}
function durationFormat(sec){const n=Math.max(0,Math.ceil(sec));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`}
function incident(now){if(!active || now-lastIncident<1450)return;bestStreak=Math.max(bestStreak,(now-streakStart)/1000);streakStart=now;lastIncident=now;incidents++;level=Math.min(4,level+1);setStage(level);$('spikes').textContent=String(incidents);msg(level>=4?'All remaining stimulation has been administratively removed.':'Micro-excitement detected. Appropriate action taken.');}
function pointerMove(ev){if(!active||cameraStream)return;let x=ev.clientX??0,y=ev.clientY??0;const now=performance.now();if(lastPointer){const dist=Math.hypot(x-lastPointer.x,y-lastPointer.y);pointerDistance+=dist;}lastPointer={x,y};if(pointerDistance>180){incident(now);pointerDistance=0;pointerWindow=now;}else if(now-pointerWindow>850){pointerDistance=0;pointerWindow=now;}}
window.addEventListener('pointermove',pointerMove,{passive:true});
window.addEventListener('touchmove',()=>{if(active&&!cameraStream)incident(performance.now())},{passive:true});
async function setupCamera(){
  // Webcam is strictly opt-in; no canvas screenshots or uploads.
  let stream,mdl;
  try{
    msg('Loading optional on-device face landmark model…');
    const mp=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
    const fs=await mp.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    mdl=await mp.FaceLandmarker.createFromOptions(fs,{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'},runningMode:'VIDEO',numFaces:1});
    if(!active||!camera.checked){mdl.close?.();return;}
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640}},audio:false});
    if(!active||!camera.checked){stream.getTracks().forEach(t=>t.stop());mdl.close?.();return;}
    camVideo=document.createElement('video');camVideo.muted=true;camVideo.playsInline=true;camVideo.srcObject=stream;await camVideo.play();faceModel=mdl;cameraStream=stream;lastGaze=null;lastGazeClock=0;gazeStatsX=new RollingStats(40);gazeStatsY=new RollingStats(40);baseline=new RollingStats(40);
    msg('Webcam mode active. Approximate gaze activity; not a neurological measurement.');
  }catch(e){stream?.getTracks().forEach(t=>t.stop());mdl?.close?.();camera.checked=false;msg('Camera mode unavailable; pointer/touch mode remains active.');console.warn('Camera initialization:',e)}
}
function cleanupCamera(){cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=null;faceModel?.close?.();faceModel=null;if(camVideo){camVideo.pause();camVideo.srcObject=null;camVideo=null;}lastGaze=null;}
function detectGaze(now){if(!faceModel||!camVideo||camVideo.readyState<2||now-lastDetectedAt<120)return;lastDetectedAt=now;let res;try{res=faceModel.detectForVideo(camVideo,now)}catch(e){console.warn(e);return}const p=res?.faceLandmarks?.[0];if(!p||p.length<478)return;const avg=indices=>indices.reduce((a,i)=>({x:a.x+p[i].x/indices.length,y:a.y+p[i].y/indices.length}),{x:0,y:0});const a=avg([468,469,470,471,472]),b=avg([473,474,475,476,477]);const gx=(a.x+b.x)/2,gy=(a.y+b.y)/2;
  gazeStatsX.push(gx);gazeStatsY.push(gy);
  if(lastGaze){const score=computeArousal({gazeX:gx,gazeY:gy,prevX:lastGaze.x,prevY:lastGaze.y,dtSec:Math.max(.02,(now-lastGazeClock)/1000),varX:gazeStatsX.variance(),varY:gazeStatsY.variance()}).arousal;
    baseline.push(score);if(now-started>2200&&score>Math.max(.10,baseline.mean()*1.6))incident(now);
  }
  lastGaze={x:gx,y:gy};lastGazeClock=now;
}
function tick(now){if(!active)return;remaining=Math.max(0,(deadline-now)/1000);$('time').textContent=durationFormat(remaining);bestStreak=Math.max(bestStreak,(now-streakStart)/1000);$('score').textContent=`${Math.floor((now-streakStart)/1000)}s`;if(cameraStream)detectGaze(now);if(remaining<=0){finish('complete');return;}raf=requestAnimationFrame(tick)}
function startSession(type){if(active)finish('ended');active=true;mode=type;remaining=type==='GAME'?60:600;started=performance.now();deadline=started+remaining*1000;streakStart=started;bestStreak=0;incidents=0;level=0;lastIncident=-Infinity;lastActivity=0;lastPointer=null;pointerDistance=0;pointerWindow=started;setStage(0);$('time').textContent=durationFormat(remaining);$('spikes').textContent='0';$('score').textContent='0s';result.classList.remove('show');game.disabled=true;reset.disabled=true;stop.disabled=false;camera.disabled=true;$('liveStatus').textContent='ACTIVE';els[0].play().catch(()=>{});msg(type==='GAME'?'One-minute boredom evaluation underway.':'Ten-minute quiet session underway.');if(camera.checked)setupCamera();raf=requestAnimationFrame(tick)}
function finish(why){if(!active)return;const now=performance.now();active=false;cancelAnimationFrame(raf);cleanupCamera();game.disabled=false;reset.disabled=false;stop.disabled=true;camera.disabled=false;$('liveStatus').textContent='COMPLETE';const total=(now-started)/1000,finalStreak=Math.max(0,(now-streakStart)/1000);bestStreak=Math.max(bestStreak,finalStreak);const label=why==='complete'?'Completed':'Ended early';$('resultTitle').textContent=incidents===0?'Officially unremarkable.':'Some excitement was detected.';$('resultText').textContent=`${label}: ${durationFormat(total)} · Incidents: ${incidents} · Longest unexcited streak: ${Math.floor(bestStreak)}s · Final stage: ${names[level]}.`;lastResult=`I tried Beige Engine: ${durationFormat(total)}, ${incidents} excitement incident(s), ${Math.floor(bestStreak)}s longest unexcited streak. ${names[level]} stage. https://beigengine.app/`;result.classList.add('show');msg('Assessment complete. Your mediocrity has been logged locally only.');try{localStorage.setItem('beige_best_streak',String(Math.max(+localStorage.getItem('beige_best_streak')||0,bestStreak)))}catch{}}
game.addEventListener('click',()=>startSession('GAME'));reset.addEventListener('click',()=>startSession('RESET'));stop.addEventListener('click',()=>finish('ended'));
$('share').addEventListener('click',async()=>{if(navigator.share){try{await navigator.share({title:'Beige Engine',text:lastResult,url:'https://beigengine.app/'});return}catch(e){if(e.name==='AbortError')return}}await copyResult()});
async function copyResult(){try{await navigator.clipboard.writeText(lastResult);msg('Result copied. Please share without enthusiasm.')}catch{msg('Copy unavailable; select the result text above.')}}$('copy').addEventListener('click',copyResult);
window.addEventListener('pagehide',()=>{if(active)finish('ended');else cleanupCamera()});
setStage(0);$('v0').play().catch(()=>{});
