// A *movement-only* proxy. It cannot measure boredom, emotion, dopamine or attention.
// MediaPipe Face Landmarker indexes: iris centers 468 and 473;
// corresponding eye corners 33/133 and 362/263; nose tip 1.
export const MOTION_THRESHOLD = 0.065;

function average(a,b){return (a+b)/2}
function eyePosition(p, iris, corner1, corner2) {
  const width=Math.hypot(p[corner1].x-p[corner2].x,p[corner1].y-p[corner2].y);
  if(width<0.012) return null;
  return {
    x:(p[iris].x-average(p[corner1].x,p[corner2].x))/width,
    y:(p[iris].y-average(p[corner1].y,p[corner2].y))/width
  };
}
export function measureFeatures(p) {
  if(!p||p.length<478) return null;
  const a=eyePosition(p,468,33,133), b=eyePosition(p,473,362,263);
  const faceWidth=Math.hypot(p[33].x-p[263].x,p[33].y-p[263].y);
  if(!a||!b||faceWidth<0.06) return null;
  return {
    eyeX:average(a.x,b.x),eyeY:average(a.y,b.y),
    headX:p[1].x/faceWidth,headY:p[1].y/faceWidth
  };
}
export function movementScore(current,previous){
  if(!current||!previous)return 0;
  const eye=Math.hypot(current.eyeX-previous.eyeX,0.5*(current.eyeY-previous.eyeY));
  const head=0.65*Math.hypot(current.headX-previous.headX,current.headY-previous.headY);
  // A change to either the eyes or the head counts as observable movement.
  return Math.min(1,Math.max(eye,head));
}
