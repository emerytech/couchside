/**
 * Couch Mode sheet (opened from the top-bar Couch button). Flings a desktop
 * (Plasma) box into Game Mode on the TV: pick the TV output, optionally HDR,
 * one tap. When the box is already in Game Mode, the sheet flips to a single
 * "Back to Desktop" exit — the return path Steam itself doesn't give you.
 *
 * State comes from the box (api.displays -> session), so the enter/exit view
 * reflects reality: dropping back to desktop from the box shows up on the next
 * poll.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, CeremonyStage, CeremonyStatus, ConnSettings, Displays, hostKey } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { mono, Palette, useTheme, useThemedStyles } from '@/lib/theme';

export function CouchModeSheet({
  visible,
  settings,
  displays,
  onChanged,
  onClose,
}: {
  visible: boolean;
  settings: ConnSettings;
  displays: Displays | null;
  /** Fired after a successful switch with the session the box is entering —
      the caller shows it optimistically (the box goes briefly unreachable
      mid-switch, so waiting on a poll leaves the UI stale). */
  onChanged: (session: 'gamescope' | 'desktop') => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inGameMode = displays?.session === 'gamescope';
  const outputs = displays?.game_outputs ?? [];
  // Show the picker only where the choice is actually honored (the agent
  // reports whether the session reads $OUTPUT_CONNECTOR). false = advisory-only
  // box (e.g. SteamOS): hide it. undefined = older agent: keep prior behavior.
  const canPickOutput = outputs.length > 1 && displays?.output_forcing !== false;
  const [output, setOutput] = useState<string>(outputs[0] ?? '');
  const [busy, setBusy] = useState(false);
  // We started a ceremony this session (POST returned a job). jobId pins which
  // job is "ours" so a stale terminal frame from an earlier ceremony can't show.
  const [started, setStarted] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);

  // Poll the ceremony status whenever the sheet is open — this is what lets a
  // SECOND phone join a ceremony the first one started (catch-up is free; the
  // agent returns the full stage array every poll). null on an older agent (404)
  // -> we stay on the synchronous path.
  const statusPoll = usePoll<CeremonyStatus | null>(
    () => api.couchModeStatus(settings), 800, visible, hostKey(settings));
  const job = statusPoll.data;

  // Show the ceremony view while a job actively runs, OR at the terminal frame
  // of the job WE started. A stale 'done' we didn't start is ignored -> picker.
  const showCeremony =
    job?.state === 'running' ||
    (started && jobId != null && job?.id === jobId &&
      (job?.state === 'done' || job?.state === 'failed'));

  // Seed the picker from the box's current outputs when the sheet OPENS — not
  // on every background poll (which would fight a mid-selection change). Also
  // reset ceremony bookkeeping so reopening after a run starts clean.
  const wasVisible = React.useRef(false);
  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opening) return;
    setOutput((cur) => (outputs.includes(cur) ? cur : outputs[0] ?? ''));
    setStarted(false);
    setJobId(null);
    setBusy(false);
  }, [visible, outputs]);

  // Fire onChanged / haptics once, on the running->terminal edge (works for our
  // own ceremony AND one we joined). onChanged updates the caller's optimistic
  // session so the top-bar reflects reality without waiting on its slow poll.
  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => {
    const s = job?.state;
    if (prevState.current === 'running' && s !== 'running') {
      if (s === 'done') {
        hapticSuccess();
        onChanged(job?.session === 'desktop' ? 'desktop' : 'gamescope');
      } else if (s === 'failed') {
        hapticError();
      }
    }
    prevState.current = s;
  }, [job?.state, job?.session, onChanged]);

  const fling = useCallback(async () => {
    // NOT `|| !output`. The same gate lived here AND on the button's disabled
    // prop; removing only the prop produced a button that looked pressable and
    // silently did nothing, which is worse than a disabled one. An empty output
    // is valid: the agent skips the pin step ("no external display selected")
    // and switches anyway, which is the whole point on an undocked handheld
    // where game_outputs is [] by design.
    if (busy) return;
    setBusy(true);
    hapticLight();
    try {
      const res = await api.couchModeStart(settings, output);
      if (res && 'stages' in res && Array.isArray(res.stages)) {
        // New agent: enter the ceremony; the poll drives the staged UI.
        setJobId(res.id);
        setStarted(true);
        statusPoll.refresh();
      } else {
        // Old agent (synchronous {ok}): today's optimistic close.
        hapticSuccess();
        onChanged('gamescope');
        onClose();
      }
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [busy, output, settings, onChanged, onClose, statusPoll]);

  const toDesktop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    hapticLight();
    try {
      await api.desktopMode(settings);
      hapticSuccess();
      onChanged('desktop');
      onClose();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [busy, settings, onChanged, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>COUCH MODE</Text>

          {showCeremony ? (
            <CeremonyView job={job!} t={t} styles={styles} onClose={onClose}
              onRetry={fling} />
          ) : inGameMode ? (
            <>
              <View style={styles.armedRow}>
                <Ionicons name="game-controller" size={18} color={t.green} />
                <Text style={styles.armedText}>Gaming on the TV</Text>
              </View>
              <Pressable
                disabled={busy}
                onPress={toDesktop}
                style={({ pressed }) => [styles.startBtn, styles.exitBtn, pressed && styles.pressed]}>
                <Ionicons name="desktop-outline" size={18} color="#fff" />
                <Text style={styles.startText}>{busy ? 'Switching…' : 'Back to Desktop'}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.blurb}>
                Move this desktop to the TV in Game Mode — display, audio, and input all
                hand over. Tap Back to Desktop to return.
              </Text>

              {canPickOutput && (
                <>
                  <Text style={styles.sub}>GAME DISPLAY</Text>
                  <View style={styles.pills}>
                    {outputs.map((name) => {
                      const on = name === output;
                      return (
                        <Pressable
                          key={name}
                          onPress={() => {
                            hapticLight();
                            setOutput(name);
                          }}
                          style={[styles.pill, on && styles.pillOn]}>
                          <Text style={[styles.pillText, on && styles.pillTextOn]}>{name}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}

              {/* NOT gated on `output`. game_outputs deliberately EXCLUDES
                  internal displays, so an undocked handheld reports [] -- and
                  since canPickOutput is also false there, no picker is shown
                  either, leaving a permanently dead button. Measured on a Steam
                  Deck OLED undocked: outputs [eDP-1 internal], game_outputs [],
                  output_forcing false, caps.couchmode TRUE.

                  The agent never required an output. couchmode_start("") is
                  supported and simply skips the pin step ("no external display
                  selected"), and couchmode_available() was relaxed to any
                  connected display precisely so undocked handhelds could fling
                  -- the app was just never updated to match. The output is a
                  PREFERENCE for multi-display boxes, not a precondition. */}
              <Pressable
                disabled={busy}
                onPress={fling}
                style={({ pressed }) => [styles.startBtn, (pressed || busy) && styles.pressed]}>
                <Ionicons name="tv-outline" size={18} color="#fff" />
                <Text style={styles.startText}>{busy ? 'Switching…' : 'Fling to TV'}</Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

type Styles = ReturnType<typeof makeStyles>;

/** Icon + color for a stage's state. running uses a spinner, handled by caller. */
function stageIcon(stage: CeremonyStage, t: Palette): { name: string; color: string } {
  if (stage.state === 'ok') return { name: 'checkmark-circle', color: t.green };
  if (stage.state === 'failed') {
    return stage.fatal
      ? { name: 'close-circle', color: t.red }
      : { name: 'warning', color: t.amber };
  }
  if (stage.state === 'skipped') {
    return { name: 'remove-circle-outline', color: t.textFaint };
  }
  return { name: 'ellipse-outline', color: t.textFaint }; // pending
}

function StageRow({ stage, t, styles }: { stage: CeremonyStage; t: Palette; styles: Styles }) {
  const icon = stageIcon(stage, t);
  return (
    <View style={styles.stageRow}>
      {stage.state === 'running' ? (
        <ActivityIndicator size="small" color={t.blue} style={styles.stageIcon} />
      ) : (
        <Ionicons name={icon.name as never} size={20} color={icon.color} style={styles.stageIcon} />
      )}
      <View style={styles.stageBody}>
        <Text style={styles.stageLabel}>{stage.label}</Text>
        {stage.reason ? <Text style={styles.stageReason}>{stage.reason}</Text> : null}
      </View>
    </View>
  );
}

/** The staged progress view: one row per stage, then a state-aware footer. */
function CeremonyView({
  job,
  t,
  styles,
  onClose,
  onRetry,
}: {
  job: CeremonyStatus;
  t: Palette;
  styles: Styles;
  onClose: () => void;
  onRetry: () => void;
}) {
  const running = job.state === 'running';
  const failed = job.state === 'failed';
  // A completed ceremony where a non-fatal stage (audio) failed -> amber note.
  const softFail = job.state === 'done' && job.stages.some(
    (s) => s.state === 'failed' && !s.fatal);
  const fatalStage = job.stages.find((s) => s.state === 'failed' && s.fatal);

  // Show the per-stage breakdown ONLY when something went wrong.
  //
  // Reported as too much information for what is, when it works, a mode switch:
  // five rows of internals for "put this on the TV". So the happy path is now a
  // spinner, then a checkmark.
  //
  // The staged VERIFICATION underneath is untouched, and the rows come straight
  // back the moment a stage fails or soft-fails. That is not a compromise, it is
  // the point: this ceremony exists because "Ready" once meant "a subprocess
  // exited 0" and cheerfully reported success onto a black TV. Hiding detail
  // that nobody needs is fine; hiding it when the thing actually broke would
  // rebuild the original bug in the UI layer.
  const showStages = failed || softFail;

  return (
    <>
      {showStages && (
        <View style={styles.stageList}>
          {job.stages.map((s) => <StageRow key={s.key} stage={s} t={t} styles={styles} />)}
        </View>
      )}

      {running && (
        <View style={styles.simpleState}>
          <ActivityIndicator size="large" color={t.blue} />
          <Text style={styles.summaryRunning}>Flinging to the TV…</Text>
        </View>
      )}
      {job.state === 'done' && !softFail && (
        <View style={styles.simpleState}>
          <Ionicons name="checkmark-circle" size={44} color={t.green} />
        </View>
      )}
      {job.state === 'done' && !softFail && (
        <Text style={[styles.summary, { color: t.green }]}>On the TV.</Text>
      )}
      {softFail && (
        <Text style={[styles.summary, { color: t.amber }]}>
          On the TV — but the sound didn&apos;t move. Check the audio row.
        </Text>
      )}
      {failed && (
        <Text style={[styles.summary, { color: t.red }]}>
          Couldn&apos;t reach Game Mode{fatalStage?.reason ? ` — ${fatalStage.reason}` : ''}.
        </Text>
      )}

      {!running && (
        <View style={styles.ceremonyBtns}>
          {failed && (
            <Pressable
              onPress={onRetry}
              style={({ pressed }) => [styles.startBtn, styles.ceremonyBtn, pressed && styles.pressed]}>
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={styles.startText}>Try again</Text>
            </Pressable>
          )}
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [
              styles.startBtn,
              styles.ceremonyBtn,
              failed && styles.ceremonyBtnSecondary,
              pressed && styles.pressed,
            ]}>
            <Text style={styles.startText}>{failed ? 'Close' : 'Done'}</Text>
          </Pressable>
        </View>
      )}
    </>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderColor: t.cardBorder,
    borderWidth: 1,
    padding: 20,
    paddingBottom: 32,
    gap: 10,
  },
  title: { color: t.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, fontFamily: mono },
  sub: { color: t.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: mono, marginTop: 6 },
  blurb: { color: t.textDim, fontSize: 13, lineHeight: 19 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  pill: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
  },
  pillOn: { borderColor: t.blue, backgroundColor: 'rgba(80,150,255,0.12)' },
  pillText: { color: t.textDim, fontSize: 14, fontWeight: '600', fontFamily: mono },
  pillTextOn: { color: t.blue },
  pressed: { opacity: 0.7 },

  startBtn: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: t.blue,
  },
  exitBtn: { backgroundColor: t.green },
  startText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  armedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: t.inset,
    borderRadius: 10,
    padding: 12,
  },
  armedText: { color: t.text, fontSize: 15 },

  // Ceremony staged view
  stageList: { marginTop: 8, gap: 2 },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  stageIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  stageBody: { flex: 1 },
  stageLabel: { color: t.text, fontSize: 15 },
  stageReason: { color: t.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  summary: { fontSize: 14, fontWeight: '600', marginTop: 10 },
  summaryRunning: { color: t.textDim, fontSize: 14, marginTop: 10 },
  simpleState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 18, gap: 10 },
  ceremonyBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },
  ceremonyBtn: { flex: 1, marginTop: 8 },
  ceremonyBtnSecondary: { backgroundColor: t.inset },
});
