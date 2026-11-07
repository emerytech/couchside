import {useCallback} from 'react';
import {useFocusEffect} from 'expo-router';
import {AppState,Platform} from 'react-native';
import {setInputLatency} from '../modules/input-latency';
/** Avoid radio power-save stalls while a connected controller is foregrounded. */
export function useInputLatency(enabled:boolean) {
  useFocusEffect(useCallback(()=>{
    if(Platform.OS!=='android')return;
    const apply=(state:string)=>setInputLatency(enabled&&state==='active');
    apply(AppState.currentState);
    const sub=AppState.addEventListener('change',apply);
    return()=>{sub.remove();setInputLatency(false);};
  },[enabled]));
}
