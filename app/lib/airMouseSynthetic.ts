import type { MotionSample } from './airMouse';
export const SYNTHETIC_GYRO_SECONDS = 30;
/** Two seconds still, five repeatable figure eights, then three seconds still. */
export function syntheticGyroSample(elapsed: number): MotionSample {
  const t=Math.max(0,elapsed), moving=t>=2 && t<27;
  return {timestamp:t,x:moving?.085*Math.cos(2*Math.PI*.4*(t-2)):0,y:0,z:moving?.13*Math.cos(2*Math.PI*.2*(t-2)):0};
}
/** Bounded source, cancelled through the same subscription handle as native gyro. */
export function startSyntheticGyro(sample:(s:MotionSample)=>void,complete:()=>void) {
  const start=performance.now();
  const timer=setInterval(()=>{
    const elapsed=(performance.now()-start)/1000;
    if(elapsed>=SYNTHETIC_GYRO_SECONDS){clearInterval(timer);complete();return;}
    sample(syntheticGyroSample(elapsed));
  },20);
  return {remove:()=>clearInterval(timer)};
}
