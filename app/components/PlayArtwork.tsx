import React, { useState } from 'react';
import { Image, type ImageSourcePropType, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/lib/theme';
import { usePlaySession } from '@/hooks/usePlayPoll';
export function PlayArtwork({ source, title, style }: { source: ImageSourcePropType; title: string; style: StyleProp<ViewStyle> }) {
  const t = useTheme(); const { demo } = usePlaySession();
  const identity = JSON.stringify(source); const [failed, setFailed] = useState('');
  return <View style={[{ backgroundColor: t.card, overflow: 'hidden' }, style]}>
    <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center', padding: 12 }]}>
      <Text style={{ color: t.green, fontSize: 24 }}>✦</Text>
      <Text numberOfLines={2} style={{ color: t.textDim, textAlign: 'center', fontWeight: '700', fontSize: 12 }}>{title}</Text>
    </View>
    {!demo && failed !== identity && <Image source={source} resizeMode="cover" style={StyleSheet.absoluteFill} onError={() => setFailed(identity)} />}
  </View>;
}
