// 2D Canvas motion proxy, not a measure of emotion, eye gaze or attention.
// Input is a sampled RGBA frame. This data is discarded after computing the next difference.
export const SAMPLE_W=48;
export const SAMPLE_H=36;
export const MOTION_THRESHOLD=0.023;
export function pixelMotion(current, previous){
  if(!previous||previous.length!==current?.length||current.length%4!==0) return 0;
  let sum=0;
  let count=0;
  for(let i=0;i<current.length;i+=4){
    const a=(current[i]*0.299+current[i+1]*0.587+current[i+2]*0.114);
    const b=(previous[i]*0.299+previous[i+1]*0.587+previous[i+2]*0.114);
    sum+=Math.abs(a-b);
    count++;
  }
  return count?Math.min(1,sum/(255*count)):0;
}
