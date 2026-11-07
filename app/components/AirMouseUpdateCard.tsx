import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { airMouseIntroState } from '@/lib/airMouseIntro';
import { setPref, usePref, usePrefsReady } from '@/lib/prefs';
import { useBoxes } from '@/lib/SettingsContext';
import { useTvs } from '@/lib/tvdirect/store';
import { useTheme } from '@/lib/theme';

/** No modal, automatic navigation, sensor activation or network request. */
export function AirMouseUpdateCard() {
  const t = useTheme();
  const { boxes, ready } = useBoxes();
  const tvs = useTvs();
  const prefsReady = usePrefsReady();
  const done = usePref('airMouseIntroDone');
  const [busy, setBusy] = useState(false);
  if (airMouseIntroState({ready: ready && tvs.ready && prefsReady, done,
    boxCount: boxes.length, tvCount: tvs.tvs.length}) !== 'offer') return null;

  async function answer(open: boolean) {
    if (busy) return;
    setBusy(true);
    await setPref('airMouseIntroDone', true).catch(() => {});
    if (open) router.push('/air-mouse-settings');
  }
  return <View style={[styles.card, {backgroundColor:t.card, borderColor:t.cardBorder}]}>
    <Pressable accessibilityRole="button" accessibilityLabel="New: Air Mouse. Explore pointing and calibration"
      accessibilityHint="Opens Air Mouse preferences without turning pointing on"
      disabled={busy} onPress={() => void answer(true)} style={styles.content}>
      <MaterialCommunityIcons name="cursor-default" size={25} color={t.blue} />
      <View style={styles.copy}>
        <Text style={[styles.title, {color:t.text}]}>New: Air Mouse</Text>
        <Text style={[styles.body, {color:t.textDim}]}>Point your phone. Touch the pad for precision.</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={20} color={t.blue} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Dismiss Air Mouse update tip"
      disabled={busy} onPress={() => void answer(false)} style={styles.dismiss}>
      <MaterialCommunityIcons name="close" size={18} color={t.textDim} />
    </Pressable>
  </View>;
}
const styles = StyleSheet.create({
  card:{marginHorizontal:14, marginTop:10, marginBottom:4, paddingLeft:12, paddingVertical:10,
    borderWidth:1, borderRadius:14, flexDirection:'row', alignItems:'center', gap:4},
  content:{flex:1, minHeight:44, flexDirection:'row', alignItems:'center', gap:10},
  copy:{flex:1, gap:3},
  title:{fontSize:15, fontWeight:'700'},
  body:{fontSize:12, lineHeight:17},
  dismiss:{width:44, minHeight:44, alignItems:'center', justifyContent:'center'},
});
