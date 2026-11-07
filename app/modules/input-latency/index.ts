import { requireOptionalNativeModule } from 'expo-modules-core';
const native=requireOptionalNativeModule<{setEnabled:(enabled:boolean)=>Promise<boolean>}>('InputLatency');
let queue=Promise.resolve();
/** Serialize focus/background edges; older native builds remain usable. */
export function setInputLatency(enabled:boolean):void {
  if(!native)return;
  queue=queue.then(()=>native.setEnabled(enabled)).then(()=>{},()=>{});
}
