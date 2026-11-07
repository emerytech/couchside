const stops=new Set<()=>void>();
export function registerCursorFlingStop(stop:()=>void){stops.add(stop);return()=>{stops.delete(stop);};}
/** Any new app touch stops momentum, without disturbing an active touch gesture. */
export function stopCursorFlings(){for(const stop of stops)stop();}
/** Touchpad-only momentum. No clicks, keys, sensors or transport ownership. */
export function createCursorFling(sink:{allowed?():boolean;move(x:number,y:number):void;active(v:boolean):void},
 clock=()=>Date.now(), schedule=(fn:()=>void)=>setTimeout(fn,16), clear=(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)) {
 let timer:ReturnType<typeof setTimeout>|undefined,vx=0,vy=0,last=0,started=0,travel=0,valid=false;
 const cancel=()=>{if(timer!==undefined)clear(timer);timer=undefined;valid=false;vx=vy=0;sink.active(false);};
 const tick=()=>{timer=undefined;const now=clock(),dt=now-last;last=now;
  if(sink.allowed?.()===false||dt<=0||dt>80||now-started>=600||travel>=1400||Math.hypot(vx,vy)<.05){cancel();return;}
  const step=Math.min(dt,32),decay=Math.exp(-step/160),factor=160*(1-decay);
  let dx=vx*factor,dy=vy*factor;const len=Math.hypot(dx,dy),scale=Math.min(1,(1400-travel)/Math.max(1,len));dx*=scale;dy*=scale;travel+=Math.hypot(dx,dy);
  vx*=decay;vy*=decay;sink.move(dx,dy);timer=schedule(tick);
 };
 return {cancel,stopGlide(){if(timer!==undefined)cancel();},
  begin(){cancel();last=clock();sink.active(true);},
  sample(dx:number,dy:number){const now=clock(),dt=now-last;last=now;
   if(!Number.isFinite(dx)||!Number.isFinite(dy)||dt<=0||dt>80){valid=false;vx=vy=0;return;}
   vx=dx/dt;vy=dy/dt;const speed=Math.hypot(vx,vy);if(speed>12){vx*=12/speed;vy*=12/speed;}valid=true;
  },
  release(eligible:boolean){const now=clock();if(sink.allowed?.()===false||!eligible||!valid||now-last>80||Math.hypot(vx,vy)<.6){cancel();return false;}
   last=started=now;travel=0;sink.active(true);timer=schedule(tick);return true;
  },
 };
}
