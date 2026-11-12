/** Track only fingers that START on this pad, independent of movement/buttons. */
export function createBg3Touchpad(sink:{fling?(eligible:boolean):void;active(v:boolean):void;move(x:number,y:number):void;click(k:'l'|'r'):void;drag(v:boolean):void;scroll(n:number):void}) {
 const touches=new Map<number,{x:number;y:number}>();let began=0,distance=0,max=0,lastTap=-Infinity,drag=false,wheel=0;
 const cancel=()=>{touches.clear();if(drag)sink.drag(false);drag=false;lastTap=-Infinity;sink.fling?.(false);sink.active(false);};
 return {cancel,
  start(id:number,x:number,y:number,now:number){if(touches.has(id))return;
   if(!touches.size){began=now;distance=0;max=0;wheel=0;drag=now-lastTap<300;lastTap=-Infinity;sink.active(true);if(drag)sink.drag(true);}
   touches.set(id,{x,y});max=Math.max(max,touches.size);if(touches.size>1&&drag){sink.drag(false);drag=false;}
  },
  move(id:number,x:number,y:number){const prev=touches.get(id);if(!prev)return;const dx=x-prev.x,dy=y-prev.y;touches.set(id,{x,y});distance+=Math.hypot(dx,dy);
   if(touches.size>1){wheel-=dy/touches.size;const n=Math.trunc(wheel/12);if(n){sink.scroll(n);wheel-=n*12;}}
   else if(max===1)sink.move(dx,dy);
  },
  end(id:number,now:number,allowFling=true){if(!touches.delete(id)||touches.size)return;
   const eligible=allowFling&&max===1&&!drag&&distance>=8;
   if(drag){sink.drag(false);drag=false;}else if(distance<8&&now-began<300){sink.click(max>1?'r':'l');if(max===1)lastTap=now;}
   sink.fling?.(eligible);sink.active(false);
  },
 };
}
