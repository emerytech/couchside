/**
 * TEMP diagnostic (WebCodecs H.264 spike) — proves the ONE gate the P4b research
 * flagged as could-kill-the-plan: does `VideoDecoder` actually work inside
 * react-native-webview's WKWebView on THIS device (not just Safari)? No primary
 * source confirmed it, so we test on hardware before building the box pipeline.
 *
 * Loads a tiny HTML page in the WebView with a SECURE-CONTEXT baseUrl (WebCodecs
 * is gated on a secure context — inline HTML with a null origin would be a false
 * negative), checks `typeof VideoDecoder` + `VideoDecoder.isConfigSupported(...)`
 * for the H.264 profiles we'd stream, and posts the result back.
 *
 * REMOVE this route + the Setup entry + the react-native-webview dep if the gate
 * fails; keep them (WebView is the decoder host) if it passes.
 */
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { useLockOrientation } from '@/hooks/useLockOrientation';

const PROBE_HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#0b0d12;color:#e8e8ea;font:13px -apple-system,system-ui;padding:14px">
<div id="out">running…</div>
<script>
function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
(async () => {
  var r = {
    hasVideoDecoder: (typeof VideoDecoder !== 'undefined'),
    hasWebCodecs: (typeof EncodedVideoChunk !== 'undefined'),
    isSecureContext: (typeof isSecureContext !== 'undefined' ? isSecureContext : null),
    origin: location.origin,
    ua: navigator.userAgent,
    configs: {}
  };
  var codecs = ['avc1.42E01E','avc1.4D401F','avc1.640028']; // baseline, main, high@4.0
  if (r.hasVideoDecoder) {
    for (var i=0;i<codecs.length;i++){
      var c = codecs[i];
      try {
        var sw = await VideoDecoder.isConfigSupported({ codec: c });
        var hw = await VideoDecoder.isConfigSupported({ codec: c, hardwareAcceleration: 'prefer-hardware' });
        r.configs[c] = { supported: !!(sw && sw.supported), hw: !!(hw && hw.supported) };
      } catch(e){ r.configs[c] = { error: String(e) }; }
    }
  }
  document.getElementById('out').innerHTML = '<pre style="white-space:pre-wrap">'+JSON.stringify(r,null,2)+'</pre>';
  post(r);
})();
</script>
</body></html>`;

export default function WebCodecsProbe() {
  useLockOrientation('portrait'); // like every screen but the Pad
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<string>('(waiting for WebView…)');
  const [verdict, setVerdict] = useState<'?' | 'PASS' | 'FAIL'>('?');

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ title: 'WebCodecs probe' }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.verdict,
          verdict === 'PASS' && { color: '#4ade80' },
          verdict === 'FAIL' && { color: '#f87171' }]}>
          VideoDecoder: {verdict}
        </Text>
      </View>

      {/* The WebView under test. Secure-context baseUrl so WebCodecs isn't gated
          off by a null origin (that would be a false negative). */}
      <WebView
        style={styles.web}
        originWhitelist={['*']}
        javaScriptEnabled
        source={{ html: PROBE_HTML, baseUrl: 'https://localhost/' }}
        onMessage={(e) => {
          const raw = e.nativeEvent.data;
          setResult(raw);
          try {
            const r = JSON.parse(raw);
            setVerdict(r.hasVideoDecoder ? 'PASS' : 'FAIL');
          } catch { /* keep raw */ }
        }}
      />

      <ScrollView style={styles.log} contentContainerStyle={{ padding: 12 }}>
        <Text style={styles.mono}>{result}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0d12' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10 },
  back: { paddingVertical: 4, paddingRight: 12 },
  backText: { color: '#7aa2ff', fontSize: 15 },
  verdict: { color: '#e8e8ea', fontSize: 15, fontWeight: '700' },
  web: { flex: 1, backgroundColor: '#0b0d12' },
  log: { maxHeight: 220, backgroundColor: '#05060a', borderTopWidth: 1, borderTopColor: '#1e2230' },
  mono: { color: '#cdd3e0', fontSize: 11, fontFamily: 'Menlo' },
});
