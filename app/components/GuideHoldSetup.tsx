import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { SegPref, TogglePref } from '@/app/(tabs)/setup';
import { usePoll } from '@/hooks/usePoll';
import { api, ApiError, ConnSettings, GuideHold, hostKey } from '@/lib/api';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/**
 * Surface the box's own reason verbatim when it answered with an error status —
 * a server-side failure that masquerades as a network error is hard to diagnose
 * from a blanket "could not reach the box". Same shape as SmartTvSetup.
 */
function saveErr(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.kind === 'http') return `${fallback} — box says: ${e.message}`;
    return `${fallback} (${e.kind})`;
  }
  return fallback;
}

const HOLD_OPTIONS = [
  { value: 800, label: 'Short' },
  { value: 1200, label: 'Normal' },
  { value: 2000, label: 'Long' },
];

/**
 * Opt into the guide-button trigger: hold the guide button on a controller while
 * the box is on the desktop, and it switches to Game Mode.
 *
 * Renders nothing when the box can't do it (older agent, no Couch Mode handoff,
 * or the agent can't read controllers) — the endpoint 404s and `guideHold`
 * resolves to null, same probe-and-appear pattern as the screensaver row.
 */
export function GuideHoldSetup({ settings }: { settings: ConnSettings }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [local, setLocal] = useState<GuideHold | null>(null);

  const poll = useCallback(() => api.guideHold(settings), [settings]);
  const { data } = usePoll(poll, 15000, true, hostKey(settings));
  const view = local ?? data;

  const patch = useCallback(
    async (p: { enabled?: boolean; hold_ms?: number; uniq?: string }) => {
      setBusy(true);
      setErr(null);
      try {
        const next = await api.guideHoldSet(settings, p);
        setLocal(next);
      } catch (e) {
        setErr(saveErr(e, 'Could not save that setting'));
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  if (!view) return null;

  const pinned = view.uniq !== '';
  // A pad the agent can see but cannot read is the likely support case: the
  // agent user is missing from group `input`, which install.sh normally grants.
  const unreadable = view.controllers.filter((c) => !c.readable);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>CONTROLLER</Text>

      <TogglePref
        label="Guide button opens Couch Mode"
        sub="Hold the guide button on your controller for about a second to move the box to the TV. Only works while the box is on the desktop — a quick tap still opens Steam as usual."
        value={view.enabled}
        onValueChange={(v) => patch({ enabled: v })}
      />

      {view.enabled && (
        <>
          <SegPref<number>
            label="How long to hold"
            sub="Longer is harder to trigger by accident."
            options={HOLD_OPTIONS}
            value={
              HOLD_OPTIONS.some((o) => o.value === view.hold_ms) ? view.hold_ms : 1200
            }
            onSelect={(v) => patch({ hold_ms: v })}
          />

          <View style={styles.padSection}>
            <Text style={styles.padHeading}>
              {pinned ? 'Only this controller' : 'Any controller'}
            </Text>
            <Text style={styles.padSub}>
              {pinned
                ? 'Other controllers are ignored, even if they are connected.'
                : 'Any controller the box can see will work.'}
            </Text>

            {view.controllers.length === 0 && (
              <Text style={styles.padEmpty}>No controllers connected right now.</Text>
            )}

            {view.controllers.map((c) => {
              const selected = pinned && c.uniq !== '' && c.uniq === view.uniq;
              // A pad with no MAC (wired) can't be pinned — Uniq is the only
              // identity stable across reconnects, and Phys is the host adapter.
              const pinnable = c.uniq !== '';
              return (
                <Pressable
                  key={c.uniq || c.phys}
                  disabled={!pinnable || busy}
                  onPress={() => patch({ uniq: selected ? '' : c.uniq })}
                  style={[styles.padRow, selected && styles.padRowActive]}>
                  <View style={styles.padBody}>
                    <Text style={styles.padName}>{c.name || 'Controller'}</Text>
                    <Text style={styles.padMeta}>
                      {!c.readable
                        ? c.reason === 'masked'
                          ? 'reserved by Steam — cannot be used here'
                          : "the box can't read this controller — re-run install.sh"
                        : pinnable
                          ? c.uniq
                          : 'wired — cannot be pinned'}
                    </Text>
                  </View>
                  {selected && <Text style={styles.padCheck}>✓</Text>}
                </Pressable>
              );
            })}

            {pinned && !view.uniq_present && (
              <Text style={styles.padWarn}>
                Waiting for your controller — it is not connected right now, so the
                guide button will not do anything.
              </Text>
            )}
          </View>

          {/* Two different causes, two different answers. A MASKED node was
              hidden on purpose by Steam / InputPlumber, which presents its own
              composite device instead; re-running install.sh cannot undo that,
              and telling people to try was sending them to do something that
              could not work. Only the plain-permission case is install-fixable.
              See KI-026 for the getfacl evidence. */}
          {unreadable.length > 0 && (
            <Text style={styles.padWarn}>
              {unreadable.every((c) => c.reason === 'masked')
                ? `Steam has reserved ${
                    unreadable.length === 1 ? 'this controller' : 'these controllers'
                  } for its own input handling, so the box cannot watch the guide button on ${
                    unreadable.length === 1 ? 'it' : 'them'
                  }. This is normal on handhelds — use another controller, or trigger Couch Mode from the app.`
                : `The box can see ${
                    unreadable.length === 1 ? 'a controller' : 'some controllers'
                  } it is not allowed to read. Re-running the install script usually fixes this.`}
            </Text>
          )}
        </>
      )}

      {busy && <ActivityIndicator color={t.blue} style={styles.spinner} />}
      {err != null && <Text style={styles.err}>{err}</Text>}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
      padding: 14,
    },
    cardTitle: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.2,
      marginBottom: 6,
    },
    padSection: { marginTop: 10 },
    padHeading: { color: t.text, fontSize: 14, fontWeight: '600' },
    padSub: { color: t.textDim, fontSize: 12, marginTop: 2, marginBottom: 8 },
    padEmpty: { color: t.textDim, fontSize: 13, fontStyle: 'italic', marginTop: 4 },
    padRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.inset,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginTop: 6,
    },
    padRowActive: { borderColor: t.blue },
    padBody: { flex: 1 },
    padName: { color: t.text, fontSize: 14, fontWeight: '600' },
    padMeta: { color: t.textDim, fontSize: 11, marginTop: 2 },
    padCheck: { color: t.blue, fontSize: 16, fontWeight: '700', marginLeft: 8 },
    padWarn: { color: t.red, fontSize: 12, marginTop: 8 },
    spinner: { marginTop: 10 },
    err: { color: t.red, fontSize: 12, marginTop: 8 },
  });
