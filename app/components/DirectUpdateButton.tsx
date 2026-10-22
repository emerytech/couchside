import { requireOptionalNativeModule } from 'expo';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme';

type Updater = {
  download(url: string): Promise<void>;
  install(): Promise<'permission' | 'installer'>;
  addListener(name: 'progress', listener: (event: { received: number; total: number }) => void): { remove(): void };
};
const updater = requireOptionalNativeModule<Updater>('DirectUpdater');

export function DirectUpdateButton({ url }: { url: string }) {
  const t = useTheme();
  const [state, setState] = useState<'idle' | 'downloading' | 'ready'>('idle');
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const listener = updater?.addListener('progress', ({ received, total }) => {
      setProgress(total > 0 ? `${Math.floor(received / total * 100)}%` : `${Math.floor(received / 1048576)} MB`);
    });
    return () => listener?.remove();
  }, []);
  async function run() {
    if (!updater) { setMessage('Install the latest Direct APK from couchside.tv to enable in-app updates.'); return; }
    setMessage('');
    if (state === 'ready') {
      try {
        const outcome = await updater.install();
        setMessage(outcome === 'permission'
          ? 'Allow updates from Couchside in Android settings, then return here and tap Install update.'
          : 'Confirm Update in Android’s installer. If you cancel, tap Install update to try again.');
      } catch { setState('idle'); setMessage('Could not open this update. Download it again and retry.'); }
      return;
    }
    setState('downloading'); setProgress('');
    try { await updater.download(url); setState('ready'); setMessage('Verified and ready. Your saved boxes and license stay in place.'); }
    catch (error) { setState('idle'); setMessage(error instanceof Error ? error.message : 'Download failed. Please retry.'); }
  }
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" disabled={state === 'downloading'} onPress={() => void run()} style={{ paddingVertical: 12 }}>
      <Text style={{ color: t.blue, fontWeight: '700' }}>{state === 'downloading' ? `Downloading… ${progress}` : state === 'ready' ? 'Install update' : 'Download update'}</Text>
    </Pressable>
    {!!message && <Text accessibilityLiveRegion="polite" style={{ color: t.textDim }}>{message}</Text>}
  </View>;
}
