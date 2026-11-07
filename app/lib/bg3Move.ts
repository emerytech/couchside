/** Keyboard/mouse-only driver. Its sink deliberately has no gamepad methods. */
export type Bg3MouseSink = {
 move(dx:number,dy:number):void;
 button(key:'l'|'r',value:0|1):void;
 key(key:'enter'|'esc'):void;
 wheel(notches:number):void;
 manual(active:boolean):void;
 camera?(key:'w'|'a'|'s'|'d',value:0|1):void;
};
export function createBg3MoveInputs(sink:Bg3MouseSink) {
 let enabled=false, touchpad=false, x=0,y=0, cameraMode=false,lastRenew=0;
 const keys=new Set<'w'|'a'|'s'|'d'>();
 const releaseKeys=()=>{for(const k of keys)sink.camera?.(k,0);keys.clear();};
 const camera=()=>{
  const next=new Set<'w'|'a'|'s'|'d'>();
  if(y>.25)next.add('w');if(y<-.25)next.add('s');if(x>.25)next.add('d');if(x<-.25)next.add('a');
  for(const k of keys)if(!next.has(k)){sink.camera?.(k,0);keys.delete(k);}
  for(const k of next)if(!keys.has(k)){sink.camera?.(k,1);keys.add(k);}
 };
 const held=new Map<string,'l'|'r'>();
 const manual=()=>sink.manual(touchpad||(!cameraMode&&(x!==0||y!==0)));
 const count=(key:'l'|'r')=>[...held.values()].filter(v=>v===key).length;
 const button=(source:string,key:'l'|'r',down:boolean)=>{
  if(!enabled)return;
  if(down){if(held.has(source))return;const n=count(key);held.set(source,key);if(!n)sink.button(key,1);}
  else {const owned=held.get(source);if(!owned)return;held.delete(source);if(!count(owned))sink.button(owned,0);}
 };
 const dispose=()=>{
  enabled=false;touchpad=false;x=y=0;releaseKeys();
  const keys=new Set(held.values());held.clear();for(const key of keys)sink.button(key,0);sink.manual(false);
 };
 return {
  activate(){enabled=true;},dispose,
  movement(mode:'camera'|'cursor'){releaseKeys();cameraMode=mode==='camera'&&!!sink.camera;x=y=0;manual();},
  stick(sx:number,sy:number){if(!enabled)return;x=Number.isFinite(sx)?Math.max(-1,Math.min(1,sx)):0;y=Number.isFinite(sy)?Math.max(-1,Math.min(1,sy)):0;if(cameraMode)camera();manual();},
  tick(now=Date.now()){if(!enabled)return;if(cameraMode){if(now-lastRenew>=100){lastRenew=now;for(const k of keys)sink.camera?.(k,1);}}else if(!touchpad&&(x||y))sink.move(Math.round(x*12),Math.round(-y*12)||0);},
  touch(active:boolean){if(!enabled)return;touchpad=active;manual();},
  move(dx:number,dy:number){if(enabled&&touchpad)sink.move(dx,dy);},
  button,
  click(source:string,key:'l'|'r'){if(!enabled)return;button(source,key,true);button(source,key,false);},
  key(key:'enter'|'esc'){if(enabled)sink.key(key);},
  wheel(n:number){if(enabled)sink.wheel(n);},
 };
}
