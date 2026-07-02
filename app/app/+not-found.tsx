import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '@/lib/theme';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={styles.container}>
        <Text style={styles.title}>This screen does not exist.</Text>
        <Link href="/" style={styles.link}>
          <Text style={styles.linkText}>Back to the console</Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: { fontSize: 18, fontWeight: '600', color: theme.text },
  link: { marginTop: 16, paddingVertical: 16 },
  linkText: { fontSize: 15, color: theme.blue },
});
