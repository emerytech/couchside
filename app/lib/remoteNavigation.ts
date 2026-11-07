export function remoteCircleDiameter(width:number,height:number):number {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return 240;
  return Math.max(132,Math.min(320,Math.floor(Math.min(width-80,height))-4));
}
export function remoteJoystickDirection(dx:number,dy:number):'up'|'down'|'left'|'right'|null {
  if(![dx,dy].every(Number.isFinite)||Math.hypot(dx,dy)<.1)return null;
  return Math.abs(dx)>=Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'down':'up');
}
