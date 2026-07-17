/**
 * Box-side agent update banner.
 *
 * PRIVACY: the check happens on the BOX (agent >= 2.9.5 /api/update/check) — the
 * box does the GitHub read; the app only reads the result over the LAN, so the
 * app itself never touches the internet. Shows what's new; the [Update] button
 * appears only when the box owner opted in on the box (`couchside allow-updates
 * on`), and even then the install is signature-verified by the box. 404 on older
 * agents -> the banner is hidden.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, UpdateCheck } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

const POLL_MS = 30 * 60 * 1000; // twice an hour; the box caches for ~6h anyway

export function AgentUpdateBanner() {
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;
  const poll = usePoll<UpdateCheck | null>(
    () => api.updateCheck(settings),
    POLL_MS,
    configured,
    hostKey(settings),
  );
  const check = poll.data;

  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const applyingRef = useRef(false);

  const apply = useCallback(async () => {
    if (applyingRef.current || !check?.latest) return;
    applyingRef.current = true;
    setApplying(true);
    setMsg('Starting the update on your box…');
    try {
      await api.applyUpdate(settings);
      setMsg('Updating — your box will restart. This can take a minute.');
      const target = check.latest;
      let done = false;
      for (let i = 0; i < 40 && !done; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const p = await api.ping(settings);
          if (p.version === target) {
            setMsg(`Updated to ${target}. `);
            poll.refresh();
            done = true;
          }
        } catch {
          // box restarting — keep polling
        }
      }
      if (!done) setMsg('Update started — it may still be finishing. Check the version shortly.');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setMsg(`Couldn't start the update (${detail}). You can run \`couchside update\` on the box.`);
    } finally {
      setApplying(false);
      applyingRef.current = false;
    }
  }, [check?.latest, poll, settings]);

  if (!check || !check.available) return null;
  if (dismissed && dismissed === check.latest) return null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="arrow-up-circle" size={18} color={theme.blue} />
        <Text style={styles.title} numberOfLines={1}>
          Agent update available{check.latest ? ` — ${check.latest}` : ''}
        </Text>
        {!applying && (
          <Pressable
            hitSlop={8}
            onPress={() => {
              hapticLight();
              setDismissed(check.latest);
            }}>
            <Ionicons name="close" size={16} color={theme.textDim} />
          </Pressable>
        )}
      </View>

      <Text style={styles.sub}>
        installed {check.installed}
        {check.tag ? ` · ${check.tag}` : ''}
      </Text>

      {check.notes ? (
        <>
          <Pressable
            onPress={() => {
              hapticLight();
              setExpanded((v) => !v);
            }}
            style={styles.notesToggle}>
            <Ionicons
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={theme.blue}
            />
            <Text style={styles.notesToggleText}>What's new</Text>
          </Pressable>
          {expanded && <Text style={styles.notes}>{check.notes}</Text>}
        </>
      ) : null}

      {msg ? (
        <Text style={styles.msg}>{msg}</Text>
      ) : check.apply_enabled ? (
        <Pressable
          onPress={() => {
            hapticLight();
            void apply();
          }}
          disabled={applying}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}>
          <Text style={styles.btnText}>{applying ? 'Updating…' : 'Update now'}</Text>
        </Pressable>
      ) : (
        <Text style={styles.hint}>
          To update, run <Text style={styles.code}>couchside update</Text> on the box — or
          enable in-app updates there with <Text style={styles.code}>couchside allow-updates on</Text>.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderColor: theme.blue,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: theme.text, fontSize: 14, fontWeight: '700', flex: 1 },
  sub: { color: theme.textDim, fontSize: 12, fontFamily: mono },
  notesToggle: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  notesToggleText: { color: theme.blue, fontSize: 13, fontWeight: '600' },
  notes: { color: theme.textDim, fontSize: 12, lineHeight: 18, fontFamily: mono },
  btn: {
    backgroundColor: theme.blue,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 2,
  },
  btnPressed: { opacity: 0.85 },
  btnText: { color: '#0b1220', fontSize: 14, fontWeight: '700' },
  msg: { color: theme.text, fontSize: 13, lineHeight: 19 },
  hint: { color: theme.textDim, fontSize: 12, lineHeight: 18 },
  code: { fontFamily: mono, color: theme.text },
});
