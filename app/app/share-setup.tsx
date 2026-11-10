import React, { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/lib/theme';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { FRIEND_MESSAGE, SETUP_FEATURES, SETUP_TYPES, setupShareText, showcaseDraftUrl } from '@/lib/setupSharing';

export default function ShareSetup() {
  const t = useTheme();
  useLockOrientation('portrait');
  const [type, setType] = useState<string>(SETUP_TYPES[0]);
  const [features, setFeatures] = useState<string[]>([SETUP_FEATURES[0]]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const summary = features.length ? setupShareText(type, features) : '';
  const card = { backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 16, padding: 18, gap: 12 };
  async function share(message: string) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      if (Platform.OS === 'web') {
        await Clipboard.setStringAsync(message);
        setNotice('Copied. Paste it wherever you want to share.');
      } else {
        await Share.share({ message }, { dialogTitle: 'Share Couchside', subject: 'My Couchside setup' });
        // Android does not distinguish dismissal from a completed share.
        setNotice('You choose where and whether to send.');
      }
    } catch { setNotice('Could not open sharing. Try Copy instead.'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await Clipboard.setStringAsync(summary); setNotice('Setup copied.'); }
    catch { setNotice('Could not copy. Please try again.'); }
  }
  function button(label: string, onPress: () => void, primary = false, disabled = false) {
    return <Pressable accessibilityRole="button" disabled={disabled || busy} onPress={onPress}
      style={{ minHeight: 48, padding: 14, borderRadius: 12, justifyContent: 'center', alignItems: 'center', opacity: disabled || busy ? .5 : 1, backgroundColor: primary ? t.blue : t.inset }}>
      <Text style={{ color: primary ? t.onAccent : t.text, fontWeight: '600', fontSize: 15 }}>{label}</Text>
    </Pressable>;
  }
  return <><Stack.Screen options={{ title: 'Share your setup', headerBackTitle: 'Back' }} />
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 18 }}>
      <Ionicons name="share-social-outline" size={30} color={t.green} />
      <Text style={{ color: t.text, fontSize: 27, fontWeight: '700' }}>Your setup. Your way to play.</Text>
      <Text style={{ color: t.textDim, fontSize: 15, lineHeight: 23 }}>Show friends how Couchside fits your gaming setup. Choose what you use, preview the message, then share it your way.</Text>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>What do you play on?</Text>
        <View accessibilityRole="radiogroup" style={{ gap: 8 }}>{SETUP_TYPES.map(x => <Pressable key={x} accessibilityRole="radio" accessibilityState={{ checked: type === x }} onPress={() => { setType(x); setNotice(''); }}
          style={{ minHeight: 44, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: type === x ? t.blue : t.cardBorder, backgroundColor: t.inset }}>
          <Text style={{ color: type === x ? t.blue : t.text }}>{type === x ? '● ' : '○ '}{x}</Text>
        </Pressable>)}</View>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700', marginTop: 8 }}>How do you use Couchside?</Text>
        {SETUP_FEATURES.map(x => <Pressable key={x} accessibilityRole="checkbox" accessibilityState={{ checked: features.includes(x) }} onPress={() => { setFeatures(old => old.includes(x) ? old.filter(v => v !== x) : [...old, x]); setNotice(''); }}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Ionicons name={features.includes(x) ? 'checkbox' : 'square-outline'} size={23} color={features.includes(x) ? t.blue : t.textDim} /><Text style={{ color: t.text, flex: 1 }}>{x}</Text>
        </Pressable>)}
      </View>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Your share preview</Text>
        <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 24 }}>{summary || 'Choose at least one feature to create your message.'}</Text>
        <Text style={{ color: t.textDim, fontSize: 12, lineHeight: 18 }}>Only the choices above are included. Your saved box names, network addresses, pairing credentials and game activity stay out of this message.</Text>
        {button(Platform.OS === 'web' ? 'Copy my setup' : 'Share my setup', () => void share(summary), true, !summary)}
        {Platform.OS !== 'web' && button('Copy message', () => void copy(), false, !summary)}
      </View>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Know someone who’d enjoy Couchside?</Text>
        <Text style={{ color: t.textDim, lineHeight: 22 }}>Send a friend a simple introduction. No referral codes or contact uploads.</Text>
        <Text selectable style={{ color: t.text, lineHeight: 22 }}>{FRIEND_MESSAGE}</Text>
        {button(Platform.OS === 'web' ? 'Copy invitation' : 'Tell a friend', () => void share(FRIEND_MESSAGE))}
      </View>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Help inspire another setup</Text>
        <Text style={{ color: t.textDim, lineHeight: 22 }}>Want to show Taylor what you’ve built? Open an email draft, add your story and optionally a photo. You review and send it yourself. We’ll ask before featuring your setup publicly.</Text>
        {button('Draft an email to Taylor', () => { void Linking.openURL(showcaseDraftUrl(summary)).then(() => setNotice('Email composer requested. Review your story and any photos before sending.'), () => setNotice('No email app available. You can contact taylor@couchside.tv.')); }, false, !summary)}
      </View>
      {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: t.textDim, lineHeight: 22 }}>{notice}</Text>}
    </ScrollView></>;
}
