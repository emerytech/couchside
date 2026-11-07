import {useCallback,useEffect,useMemo,useRef} from 'react';
import {AppState} from 'react-native';
import {useFocusEffect} from 'expo-router';
import {usePref} from '@/lib/prefs';
import {useSettings} from '@/lib/SettingsContext';
import {createCursorFling,registerCursorFlingStop} from '@/lib/cursorFling';
/** Keep gyro paused until touchpad momentum finishes, and cancel on lifecycle/target changes. */
export function useCursorFling(move:(x:number,y:number)=>void,active?:(v:boolean)=>void,allowed= true) {
 const distance=usePref('cursorFlingDistance'),enabled=usePref('cursorFling'),{settings}=useSettings();
 const focused=useRef(false);
 const current=useRef({move,active,allowed,enabled});current.current={move,active,allowed,enabled};
 const fling=useMemo(()=>createCursorFling({allowed:()=>current.current.enabled&&current.current.allowed&&focused.current&&AppState.currentState==='active',move:(x,y)=>current.current.move(x,y),active:v=>current.current.active?.(v)}),[]);
 useEffect(()=>registerCursorFlingStop(fling.stopGlide),[fling]);
 useEffect(()=>{fling.cancel();return()=>fling.cancel();},[fling,enabled,settings,allowed,distance]);
 useFocusEffect(useCallback(()=>{focused.current=true;return()=>{focused.current=false;fling.cancel();};},[fling]));
 useEffect(()=>{const s=AppState.addEventListener('change',state=>{if(state!=='active')fling.cancel();});return()=>{s.remove();fling.cancel();};},[fling]);
 return {begin:fling.begin,sample:fling.sample,cancel:fling.cancel,release:(eligible:boolean)=>fling.release(enabled&&eligible,distance)};
}
