import { useState } from 'react';
import { Stack, router } from 'expo-router';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { setPref, usePref } from '@/lib/prefs';
import { useSettings } from '@/lib/SettingsContext';
import { api } from '@/lib/api';
import { useLockOrientation } from '@/hooks/useLockOrientation';
export default function AirMouseSettings() {
  const t = useTheme(), {settings} = useSettings();
  const enabled=usePref('airMouseEnabled'),large=usePref('airMouseLargeCursor'),speed=usePref('airMouseSpeed');
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  useLockOrientation('portrait');
  const row={padding:16,borderRadius:14,borderWidth:1,borderColor:t.cardBorder,backgroundColor:t.card};
  return <><Stack.Screen options={{title:'Air Mouse preferences'}}/><ScrollView style={{flex:1,backgroundColor:t.bg}} contentContainerStyle={{padding:18,gap:16,paddingBottom:50}}>
    <Text style={{color:t.text,fontSize:24,fontWeight:'700'}}>Air Mouse</Text>
    <Text style={{color:t.textDim}}>Point the top of your phone toward the TV with its screen facing up. Quick calibrate and Recenter stay beside the touchpad.</Text>
    <View style={[row,{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}]}><View style={{flex:1}}><Text style={{color:t.text}}>Start on in Mouse mode</Text><Text style={{color:t.textDim,fontSize:12}}>Stops when leaving, backgrounding or rotating.</Text></View><Switch accessibilityLabel="Start Air Mouse on" value={enabled} onValueChange={v=>{void setPref('airMouseEnabled',v);}}/></View>
    <View style={row}><Text style={{color:t.text,marginBottom:12}}>Pointing speed</Text><View style={{flexDirection:'row',gap:8}}>{([['Slow',.25],['Normal',1],['Fast',1.5]] as const).map(([name,v])=><Pressable key={name} accessibilityRole="radio" accessibilityState={{checked:speed===v}} onPress={()=>{void setPref('airMouseSpeed',v);}} style={{padding:12,borderRadius:10,backgroundColor:speed===v?t.blue:t.inset}}><Text style={{color:speed===v?t.bg:t.text}}>{name}</Text></Pressable>)}</View></View>
    <View style={row}><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><Text style={{color:t.text}}>Larger cursor (preview)</Text><Switch accessibilityLabel="Larger Air Mouse cursor" value={large} onValueChange={v=>{void setPref('airMouseLargeCursor',v);}}/></View><Text style={{color:t.textDim,fontSize:12}}>Experimental: temporarily enlarges the current arrow on supported Linux/Xwayland boxes. Gamescope and app-drawn cursors may keep their own size. Restores when Air Mouse stops or loses contact. Other platforms keep their normal cursor.</Text></View>
    <Pressable style={row} accessibilityRole="button" disabled={busy} onPress={()=>{setBusy(true);void api.airMouseShow(settings).then(()=>{router.replace('/pad');},()=>setMessage('Could not open setup. Check the selected box and agent version.')).finally(()=>setBusy(false));}}><Text style={{color:t.blue,fontWeight:'700'}}>Four-target setup on box</Text><Text style={{color:t.textDim,fontSize:12}}>Aim at each target and use Click on the Mouse toolbar to confirm.</Text></Pressable>
    {!!message&&<Text style={{color:t.textDim}}>{message}</Text>}
  </ScrollView></>;
}
