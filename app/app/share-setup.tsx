import React, { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/lib/theme';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { STORY_QUESTIONS, STORY_ANSWER_LIMIT, type CouchsideStory, setupShareText, showcaseDraftUrl } from '@/lib/setupSharing';

export default function ShareSetup() {
  const t = useTheme();
  useLockOrientation('portrait');
  const [answers, setAnswers] = useState<CouchsideStory>({ favorite: '', mostUsed: '', future: '' });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const summary = Object.values(answers).some(value => value.trim()) ? setupShareText(answers) : '';
  const card = { backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 16, padding: 18, gap: 12 };
  async function share(message: string) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      if (Platform.OS === 'web') {
        await Clipboard.setStringAsync(message);
        setNotice('Copied. Paste it wherever you want to share.');
      } else {
        await Share.share({ message }, { dialogTitle: 'Share Couchside', subject: 'How I use Couchside' });
        // Android does not distinguish dismissal from a completed share.
        setNotice('You choose where and whether to send.');
      }
    } catch { setNotice('Could not open sharing. Try Copy instead.'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await Clipboard.setStringAsync(summary); setNotice('Answers copied.'); }
    catch { setNotice('Could not copy. Please try again.'); }
  }
  function button(label: string, onPress: () => void, primary = false, disabled = false) {
    return <Pressable accessibilityRole="button" disabled={disabled || busy} onPress={onPress}
      style={{ minHeight: 48, padding: 14, borderRadius: 12, justifyContent: 'center', alignItems: 'center', opacity: disabled || busy ? .5 : 1, backgroundColor: primary ? t.blue : t.inset }}>
      <Text style={{ color: primary ? t.onAccent : t.text, fontWeight: '600', fontSize: 15 }}>{label}</Text>
    </Pressable>;
  }
  return <><Stack.Screen options={{ title: 'Your Couchside story', headerBackTitle: 'Back' }} />
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 18 }}>
      <Ionicons name="share-social-outline" size={30} color={t.green} />
      <Text style={{ color: t.text, fontSize: 27, fontWeight: '700' }}>How do you Couchside?</Text>
      <Text style={{ color: t.textDim, fontSize: 15, lineHeight: 23 }}>Tell us what you enjoy, what you use most, and what you’d love to see next. Answer any or all three.</Text>
      <View style={card}>
        {STORY_QUESTIONS.map(({ key, label }) => <View key={key} style={{ gap: 8 }}>
          <Text nativeID={`story-${key}`} style={{ color: t.text, fontSize: 16, fontWeight: '600', lineHeight: 23 }}>{label}</Text>
          <TextInput accessibilityLabel={label} multiline maxLength={STORY_ANSWER_LIMIT} value={answers[key]}
            placeholder="Your answer…" placeholderTextColor={t.textFaint} textAlignVertical="top"
            onChangeText={value => { setAnswers(old => ({ ...old, [key]: value })); setNotice(''); }}
            style={{ minHeight: 110, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.inset, color: t.text, fontSize: 15, lineHeight: 23 }} />
          <Text style={{ color: t.textFaint, fontSize: 12, textAlign: 'right' }}>{answers[key].length}/{STORY_ANSWER_LIMIT}</Text>
        </View>)}
      </View>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Your share preview</Text>
        <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 24 }}>{summary || 'Your answers will appear here before you share.'}</Text>
        <Text style={{ color: t.textDim, fontSize: 12, lineHeight: 18 }}>Only the answers you type are included. Leave out passwords, pairing codes, network addresses and other personal details.</Text>
        {button(Platform.OS === 'web' ? 'Copy my answers' : 'Share my answers', () => void share(summary), true, !summary)}
        {Platform.OS !== 'web' && button('Copy message', () => void copy(), false, !summary)}
      </View>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Share with Taylor</Text>
        <Text style={{ color: t.textDim, lineHeight: 22 }}>Send your feedback or offer your story for a future showcase. This opens an email draft for you to review and send. We’ll ask before publishing your answers or name.</Text>
        {button('Draft an email to Taylor', () => { void Linking.openURL(showcaseDraftUrl(summary)).then(() => setNotice('Email composer requested. Review your answers before sending.'), () => setNotice('No email app available. You can contact taylor@couchside.tv.')); }, false, !summary)}
      </View>
      {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: t.textDim, lineHeight: 22 }}>{notice}</Text>}
    </ScrollView></>;
}
