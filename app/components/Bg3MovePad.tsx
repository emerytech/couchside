import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {AppState,Pressable,StyleSheet,Text,View} from 'react-native';
import {useFocusEffect} from 'expo-router';
import {PadTouchSurface} from './PadTouchSurface';
import {AirMouseControls} from './AirMouseControls';
import {Bg3Touchpad} from './Bg3Touchpad';
import {usePref,setPref} from '@/lib/prefs';
import {useTheme,mono} from '@/lib/theme';
import {createBg3MoveInputs} from '@/lib/bg3Move';
import {bg3MoveExtras} from '@/lib/bg3MoveLayout';
import {airMousePlacement} from '@/lib/airMousePlacement';
import {padTouchControls} from '@/lib/padTouchLayouts';
import {FloatingStick,PadKey,ChromeButton} from './LandscapePad';
import type {PadLayout,Rect} from '@/lib/padLayout';
import type {ButtonKey,GamepadClient} from '@/lib/gamepad';
const abs=(r:Rect)=>({position:'absolute' as const,left:r.x,top:r.y,width:r.w,height:r.h});
export function Bg3MovePad({layout,client,targetKey,available,locked,onToggleLock,onExit}:{
 layout:Extract<PadLayout,{ok:true}>;client:GamepadClient;targetKey:string;available:boolean;
 locked:boolean;onToggleLock():void;onExit():void;
}) {
 const t=useTheme(), camera=usePref('bg3MoveCamera');
 const [manual,setManual]=useState(false),manualRef=useRef(false),live=useRef(available);live.current=available;
 const usable=available&&client.supportsKeyboardOnly();
 const inputs=useMemo(()=>createBg3MoveInputs({
  move(dx,dy){if(live.current)client.sendMouseMove(dx,dy);},
  button(k,v){if(live.current||v===0)client.sendMouseButton(k,v);},
  key(k){if(live.current)client.sendKey(k);},wheel(n){if(live.current)client.sendWheel(n);},
  camera(k,v){if(live.current||v===0)client.sendCameraKey(k,v);},
  manual(active){manualRef.current=active;setManual(active);if(active)client.cancelMouseMove();},
 }),[client]);
 const cameraMode=camera&&client.supportsCameraKeys();
 useLayoutEffect(()=>{inputs.dispose();inputs.movement(cameraMode?'camera':'cursor');if(usable)inputs.activate();return()=>{inputs.dispose();client.cancelMouseMove();};},[inputs,usable,cameraMode,layout,client]);
 useFocusEffect(useCallback(()=>{if(live.current&&client.supportsKeyboardOnly())inputs.activate();return()=>inputs.dispose();},[inputs,client]));
 useEffect(()=>{const sub=AppState.addEventListener('change',s=>{if(s!=='active')inputs.dispose();});return()=>sub.remove();},[inputs]);
 useEffect(()=>{if(!usable)return;const timer=setInterval(()=>inputs.tick(),20);return()=>clearInterval(timer);},[inputs,usable]);
 const extras=useMemo(()=>bg3MoveExtras(layout),[layout]);
 const controls=useMemo(()=>padTouchControls(layout,'move').filter(c=>c.id!=='nav'&&c.id!=='start'),[layout]);
 const excluded=useMemo(()=>[...layout.nodes.filter(n=>n.layer===9).map(n=>n.hit),extras.pad,extras.left,extras.right],[layout,extras]);
 const btn=useCallback((key:ButtonKey)=>({onDown(){if(key==='a')inputs.key('enter');else if(key==='b'||key==='start')inputs.key('esc');},onUp(){}}),[inputs]);
 const noTrigger=useCallback(()=>({onDown(){},onUp(){}}),[]);
 const stickMove=useCallback((_key:'l'|'r')=>((x:number,y:number)=>inputs.stick(x,y)),[inputs]);
 const stickRelease=useCallback((_key:'l'|'r')=>()=>inputs.stick(0,0),[inputs]);
 const anchor=airMousePlacement(layout.play,[...layout.nodes.filter(n=>n.id!=='nav').map(n=>n.hit),extras.pad,extras.left,extras.right]);
 const {byId:n,u}=layout;
 const mouseButton=(key:'l'|'r',r:Rect)=><Pressable key={key} accessibilityRole="button" accessibilityLabel={key==='l'?'Left mouse button':'Right mouse button'} disabled={!usable}
  onPressIn={()=>inputs.button('button-'+key,key,true)} onPressOut={()=>inputs.button('button-'+key,key,false)}
  style={({pressed})=>[abs(r),{borderWidth:1,borderColor:t.blue,borderRadius:12,backgroundColor:pressed?t.inset:t.card,alignItems:'center',justifyContent:'center'}]}>
  <Text style={{color:t.blue,fontWeight:'700',fontSize:12}}>{key==='l'?'LEFT CLICK':'RIGHT CLICK'}</Text>
 </Pressable>;
 return <View style={[StyleSheet.absoluteFill,{backgroundColor:t.bg}]}>
  <PadTouchSurface controls={usable&&extras.ok?controls:[]} excluded={excluded} btn={btn} trig={noTrigger} stickMove={stickMove} stickRelease={stickRelease} style={StyleSheet.absoluteFill}>
   <FloatingStick node={n.move} u={u} label={cameraMode?'Camera · WASD':'Cursor'} zoneOutline onMove={stickMove('l')} onRelease={stickRelease('l')} onClick={()=>{}}/>
   <PadKey node={n.a} u={u} label={"Confirm /\nEnter"} fontSize={2.5*u} {...btn('a')}/>
   <PadKey node={n.b} u={u} label={"Back /\nEsc"} fontSize={2.5*u} {...btn('b')}/>
  </PadTouchSurface>
  {extras.ok&&<>
   <Bg3Touchpad rect={extras.pad} enabled={usable} label={'TOUCHPAD\nTap to select · two fingers to scroll'+(camera&&!client.supportsCameraKeys()?'\nCursor mode · update agent for WASD':'')}
    onActive={v=>inputs.touch(v)} onMove={(x,y)=>inputs.move(x,y)} onClick={k=>inputs.click('pad-tap',k)}
    onDrag={v=>inputs.button('pad-drag','l',v)} onScroll={n=>inputs.wheel(n)}/>
   {mouseButton('l',extras.left)}{mouseButton('r',extras.right)}
  </>}
  <ChromeButton node={n.start} u={u} text="ESC" onPress={()=>inputs.key('esc')} accessibilityLabel="Game menu or cancel"/>
  <ChromeButton node={n.lock} u={u} text={locked?'🔒 LOCK':'🔓 AUTO'} onPress={onToggleLock} accessibilityLabel="Toggle orientation lock"/>
  <ChromeButton node={n.exit} u={u} text="✕ EXIT" onPress={onExit} accessibilityLabel="Exit Baldur’s Gate MOVE"/>
  <ChromeButton node={n.theme} u={u} text={cameraMode?'WASD':'CURSOR'} onPress={()=>void setPref('bg3MoveCamera',!camera)} accessibilityLabel="Switch movement zone between camera and cursor"/>
  {anchor&&extras.ok&&<View pointerEvents="box-none" style={{...abs(anchor),zIndex:20}}>
   <AirMouseControls floating allowLandscape defaultOn targetKey={targetKey+':bg3'} available={usable} touchpadActive={manual}
    onMove={(x,y,current)=>{if(current()&&!manualRef.current)client.sendMouseMove(x,y);}}
    onClick={current=>{if(current())inputs.click('air','l');}} onStop={()=>client.cancelMouseMove()}/>
  </View>}
  {(!usable||!extras.ok)&&<View style={{position:'absolute',top:layout.play.y+layout.play.h*.3,left:layout.play.x+12,right:12,padding:16,backgroundColor:t.card,borderRadius:12}}>
   <Text style={{color:t.text}}>{!extras.ok?'More screen space is needed for this layout. Try rotating the phone.':available?'Update this box’s agent for keyboard/mouse-only MOVE.':'Reconnect to use this preset.'}</Text>
  </View>}
 </View>;
}
