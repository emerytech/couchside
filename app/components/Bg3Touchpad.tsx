import {useEffect,useMemo,useRef} from 'react';
import {View,Text,type GestureResponderEvent} from 'react-native';
import {createBg3Touchpad} from '@/lib/bg3Touchpad';
import {useCursorFling} from '@/hooks/useCursorFling';
import {usePref} from '@/lib/prefs';
import {useTheme,mono} from '@/lib/theme';
import type {Rect} from '@/lib/padLayout';
export function Bg3Touchpad({rect,enabled,label,onActive,onMove,onClick,onDrag,onScroll}:{rect:Rect;enabled:boolean;label:string;
 onActive(v:boolean):void;onMove(x:number,y:number):void;onClick(k:'l'|'r'):void;onDrag(v:boolean):void;onScroll(n:number):void}) {
 const t=useTheme(),sensitivity=usePref('trackpadSensitivity'),natural=usePref('naturalScroll');
 const view=useRef<View>(null),origin=useRef<{x:number;y:number}|null>(null);
 const current=useRef({enabled,onActive,onMove,onClick,onDrag,onScroll,sensitivity,natural});current.current={enabled,onActive,onMove,onClick,onDrag,onScroll,sensitivity,natural};
 const fling=useCursorFling((x,y)=>{if(current.current.enabled)current.current.onMove(x,y);},v=>current.current.onActive(v),enabled);
 const flingRef=useRef(fling);flingRef.current=fling;
 const pad=useMemo(()=>createBg3Touchpad({active:v=>{if(v)flingRef.current.begin();}, fling:ok=>flingRef.current.release(ok),
 move:(x,y)=>{if(current.current.enabled){current.current.onMove(x*current.current.sensitivity,y*current.current.sensitivity);flingRef.current.sample(x*current.current.sensitivity,y*current.current.sensitivity);}},
 click:k=>{if(current.current.enabled)current.current.onClick(k);},drag:v=>{if(!v||current.current.enabled)current.current.onDrag(v);},
 scroll:n=>{if(current.current.enabled)current.current.onScroll(current.current.natural?-n:n);}}),[]);
 useEffect(()=>{pad.cancel();flingRef.current.cancel();return()=>{pad.cancel();flingRef.current.cancel();};},[pad,enabled,rect]);
 const event=(kind:'start'|'move'|'end',e:GestureResponderEvent)=>{
  if(!enabled){pad.cancel();return;}
  for(const p of e.nativeEvent.changedTouches){
   const id=Number(p.identifier);
   if(kind==='start'){
    const o=origin.current;if(o&&p.pageX>=o.x&&p.pageX<=o.x+rect.w&&p.pageY>=o.y&&p.pageY<=o.y+rect.h)pad.start(id,p.pageX,p.pageY,Date.now());
   }else if(kind==='move')pad.move(id,p.pageX,p.pageY);else pad.end(id,Date.now(),e.nativeEvent.touches.length===0);
  }
 };
 return <View ref={view} collapsable={false} onLayout={()=>{origin.current=null;view.current?.measureInWindow((x,y)=>{origin.current={x,y};});}}
  onTouchStart={e=>event('start',e)} onTouchMove={e=>event('move',e)} onTouchEnd={e=>event('end',e)} onTouchCancel={()=>{pad.cancel();flingRef.current.cancel();}}
  accessibilityLabel="Baldur’s Gate 3 touchpad" style={{position:'absolute',left:rect.x,top:rect.y,width:rect.w,height:rect.h,backgroundColor:t.card,borderColor:t.cardBorder,borderWidth:1,borderRadius:16,alignItems:'center',justifyContent:'center'}}>
  <Text pointerEvents="none" style={{color:t.textDim,fontFamily:mono,fontSize:12,textAlign:'center'}}>{label}</Text>
 </View>;
}
