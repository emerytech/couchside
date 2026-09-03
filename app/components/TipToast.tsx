/**
 * "Did you know" — one contextual tip, on the tab it belongs to, once each.
 *
 * Modelled on ReviewToast (same slot above the tab bar, same dismiss shape)
 * rather than the pointer-events-none AppToast, because a tip has a button:
 * SHOW ME scrolls the tab to the control it describes. Every rule that keeps
 * this from becoming clutter lives in lib/tips.ts; this file is the timer and
 * the pixels.
 *
 * Mounted once in the tabs layout, which knows the active tab and whether the
 * tour or its thank-you is on screen. A tip never appears over either.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { measureAnchor, scrollTabBy } from '@/hooks/useTourAnchor';
import { subscribeReviewInvite } from '@/lib/review';
import { hapticLight } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { canShowTip, markTipShown, pickCandidates, useTipsState, type Tip } from '@/lib/tips';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';

/** Let the tab settle and its cards finish probing before offering anything —
 *  a tip that lands on a still-loading screen reads as noise. */
const SETTLE_MS = 6000;
/** Long enough to read twice. It asks nothing, so it need not linger. */
const TOAST_MS = 14000;

type Props = {
  /** Route name of the tab on screen ('index', 'pad', …), or null if unknown. */
  tab: string | null;
  /** At least one box paired. Tips describe box features; none before that. */
  paired: boolean;
  /** Something else owns the screen (feature tour, its thank-you). */
  busy: boolean;
};

export function TipToast({ tab, paired, busy }: Props) {
  const enabled = usePref('featureTour');
  const tips = useTipsState(); // subscribed so a reset re-arms the timer below
  const [tip, setTip] = useState<Tip | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);

  // The review invite owns this same slot and matters more (Apple rating), so
  // it wins: a pending invite pulls any tip and blocks a new one for a window.
  // ReviewToast is mounted at the root, out of this tree's reach, so we listen
  // to the same source it does rather than to the toast. One interruption at a
  // time — the whole reason tips exist.
  const reviewActive = useRef(false);
  useEffect(() => {
    let clear: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeReviewInvite(() => {
      reviewActive.current = true;
      setTip(null);
      if (clear) clearTimeout(clear);
      clear = setTimeout(() => { reviewActive.current = false; }, 20000);
    });
    return () => {
      unsub();
      if (clear) clearTimeout(clear);
    };
  }, []);

  // Arm when the tab settles. The gate is re-evaluated at fire time too: the
  // user may have opened the tour, or another tab may have shown today's tip.
  useEffect(() => {
    if (!enabled || !paired || busy || !tips.ready || !tab) return;
    if (!canShowTip()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        if (cancelled || reviewActive.current || !canShowTip()) return;
        for (const cand of pickCandidates(tab)) {
          // Never describe a control the user cannot see (the tour's rule).
          if (cand.anchor && !(await measureAnchor(cand.anchor))) continue;
          if (cancelled) return;
          markTipShown(cand.id);
          setTip(cand);
          if (hideTimer.current) clearTimeout(hideTimer.current);
          hideTimer.current = setTimeout(() => setTip(null), TOAST_MS);
          return;
        }
      })();
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, paired, busy, tab, tips.ready, tips.lastDay]);

  // Yield to anything modal, and don't follow the user to another tab — a tip
  // about the Console shown on the Pad points at nothing.
  useEffect(() => {
    if (busy) setTip(null);
  }, [busy]);
  useEffect(() => {
    setTip((cur) => (cur && cur.tab !== 'any' && cur.tab !== tab ? null : cur));
  }, [tab]);
  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const onDismiss = useCallback(() => {
    hapticLight();
    setTip(null);
  }, []);

  const onShow = useCallback(() => {
    hapticLight();
    const t = tip;
    setTip(null);
    if (!t?.anchor || t.tab === 'any') return;
    void measureAnchor(t.anchor).then((r) => {
      // Bring it just below the header. scrollTabBy takes a DELTA; a tab that
      // never registered a scroller no-ops, which is fine — it is on screen.
      if (r) scrollTabBy(t.tab, r.y - 140);
    });
  }, [tip]);

  if (!tip) return null;

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + 76 }]}>
      <View style={styles.toast} accessibilityRole="alert">
        <Text style={styles.eyebrow}>{tip.eyebrow ?? 'DID YOU KNOW'}</Text>
        <Text style={styles.text}>{tip.text}</Text>
        <View style={styles.actions}>
          {tip.anchor ? (
            <Pressable
              onPress={onShow}
              accessibilityRole="button"
              accessibilityLabel="Show me"
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
              <Text style={styles.btnText}>SHOW ME</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Got it"
            style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
            <Text style={styles.btnPrimaryText}>GOT IT</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: {
    maxWidth: '92%',
    backgroundColor: t.card,
    borderColor: t.blue,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  eyebrow: {
    color: t.blue,
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    textAlign: 'center',
  },
  text: { color: t.text, fontSize: 13, marginTop: 6, textAlign: 'center', lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  btnText: { color: t.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  btnPrimary: { backgroundColor: t.blue, borderColor: t.blue },
  btnPrimaryText: { color: '#0b1220', fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  pressed: { opacity: 0.7 },
});
