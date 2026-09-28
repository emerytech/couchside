/**
 * A themed confirm dialog to replace the native `Alert.alert(title, msg, [...])`
 * — which renders the OS's stock grey sheet, jarringly off-brand against the
 * app's dark cards. `useConfirm()` returns a promise-based `confirm(opts)` so a
 * call site reads:
 *
 *     if (await confirm({ title: 'Launch on the box?', message: '…',
 *                         confirmText: 'Launch' })) { … }
 *
 * One <Modal> lives at the root (ConfirmProvider). Destructive actions pass
 * `destructive` to tint the confirm button red. Dismiss (backdrop / back button /
 * Cancel) resolves false, so a stray tap never fires the action.
 */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { useThemedStyles, type Palette } from '@/lib/theme';

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(
  async () => false,
);

/** Await a themed yes/no. Resolves true only when the user taps the confirm
 *  button; Cancel, the backdrop, and the Android back button all resolve false. */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const [pending, setPending] = useState<Pending | null>(null);
  // Guard against a double-resolve (backdrop + button racing).
  const settled = useRef(false);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      settled.current = false;
      setPending({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setPending((p) => {
      if (p && !settled.current) {
        settled.current = true;
        p.resolve(ok);
      }
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        visible={pending !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => close(false)}>
        <Pressable style={styles.backdrop} onPress={() => close(false)}>
          {/* Stop taps on the card from dismissing. */}
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>{pending?.title}</Text>
            {pending?.message ? <Text style={styles.message}>{pending.message}</Text> : null}
            <View style={styles.row}>
              <Pressable
                onPress={() => close(false)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.btn, styles.cancel, pressed && styles.pressed]}>
                <Text style={styles.cancelText}>{pending?.cancelText ?? 'Cancel'}</Text>
              </Pressable>
              <Pressable
                onPress={() => { hapticLight(); close(true); }}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.btn,
                  pending?.destructive ? styles.destructive : styles.confirm,
                  pressed && styles.pressed,
                ]}>
                <Text style={pending?.destructive ? styles.destructiveText : styles.confirmText}>
                  {pending?.confirmText ?? 'OK'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ConfirmContext.Provider>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.62)',
      alignItems: 'center', justifyContent: 'center', padding: 28,
    },
    card: {
      width: '100%', maxWidth: 360, backgroundColor: t.card,
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 18, padding: 20,
    },
    title: { color: t.text, fontSize: 18, fontWeight: '800' },
    message: { color: t.textDim, fontSize: 14, lineHeight: 20, marginTop: 8 },
    row: { flexDirection: 'row', gap: 10, marginTop: 20 },
    btn: { flex: 1, borderRadius: 999, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
    cancel: { backgroundColor: t.inset },
    cancelText: { color: t.textDim, fontSize: 15, fontWeight: '700' },
    confirm: { backgroundColor: t.green },
    confirmText: { color: t.onAccent, fontSize: 15, fontWeight: '800' },
    destructive: { backgroundColor: t.red },
    destructiveText: { color: t.onAccent, fontSize: 15, fontWeight: '800' },
    pressed: { opacity: 0.6 },
  });
