import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { BootSessionCard } from '@/components/BootSessionCard';
import { EditableSection } from '@/components/EditableSection';
import { UtilitiesSection } from '@/components/UtilitiesSection';
import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { TourAnchor } from '@/components/TourAnchor';
import { registerScroller } from '@/hooks/useTourAnchor';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { ActionInfo, ActionResult, api, Danger, hostKey } from '@/lib/api';
import { effectiveOrder, moveSection } from '@/lib/cardLayout';
import { useActionsLayout, setActionsLayout } from '@/lib/actionsLayout';
import {
  hapticError,
  hapticHeavy,
  hapticLight,
  hapticSelection,
  hapticSuccess,
} from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { useSettings } from '@/lib/SettingsContext';
import { mono, numeric, textOn, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const DANGER_ORDER: Danger[] = ['low', 'medium', 'high'];

// The agent's action contract keeps low/medium/high (custom actions set it too,
// and 'high' still gates the extra confirm), but showing it as "DANGER" badly
// overstates what these do: Switch to Desktop isn't dangerous, it just changes
// what's on the TV. Label by IMPACT — what the user actually loses by tapping —
// and let colour carry the severity instead of the word "danger".
const GROUP_TITLE: Record<Danger, string> = {
  low: 'ROUTINE',
  medium: 'CHANGES WHAT’S ON SCREEN',
  high: 'ENDS YOUR SESSION',
};
/** Feature-tour anchor per group. Spelled out as LITERALS rather than built
 *  with a template string: a test reads this source to prove every anchor named
 *  in lib/tour.ts is actually registered somewhere, and an interpolated id is
 *  invisible to it. A tour step whose anchor never registers does not crash — it
 *  silently never shows — so the typo has to be caught here or not at all. */
const TOUR_ANCHOR: Record<Danger, string> = {
  low: 'actions.routine',
  medium: 'actions.medium',
  high: 'actions.high',
};
const BADGE_TEXT: Record<Danger, string> = {
  low: 'routine',
  medium: 'interrupts',
  high: 'ends session',
};

/** The Actions tab's movable SECTIONS for hold-to-edit reorder/hide (same store
 *  as the Console). 'boot' is the Boot Session card; the other three are the
 *  impact groups keyed by the UI's word (low → 'routine'). The Utilities surface
 *  is deliberately absent — it stays pinned, never reordered or hidden. */
const SECTION_ORDER = ['boot', 'routine', 'medium', 'high'] as const;

/** Seconds a session-ending action waits, cancellable, before it actually fires.
 *  This REPLACES the old blind second "Are you sure?" dialog: one confirm, then a
 *  visible countdown you can cancel — which also catches the fleet-era mistake the
 *  dialogs cannot, confirming with the WRONG BOX selected (the box is named in the
 *  countdown). App-side only: the request is simply not sent until the window
 *  elapses, so leaving the screen or switching boxes cancels it for free. */
const COUNTDOWN_SECS = 5;

/** Confirm helper that also works on web (Alert buttons are no-ops on web). */
function confirm(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Run', style: 'destructive', onPress: onConfirm },
  ]);
}

type RunRecord = {
  action: ActionInfo;
  result?: ActionResult;
  error?: string;
  running: boolean;
};

export default function ActionsTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <ActionsScreen />
      </Gated>
    </TabScreen>
  );
}

function ActionsScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const [run, setRun] = useState<RunRecord | null>(null);
  // A session-ending action that has been confirmed and is counting down. Null
  // when nothing is pending. Cleared (never fired) by Cancel, a box switch, or
  // leaving the screen.
  const [pending, setPending] = useState<{ action: ActionInfo; secs: number } | null>(null);

  const DANGER_COLOR = useMemo<Record<Danger, string>>(
    () => ({ low: t.slate, medium: t.amber, high: t.red }),
    [t],
  );

  // No host yet (fresh install): don't poll, and show the pairing hint instead
  // of a red "Box unreachable" banner retrying every 2s against http://:8787.
  const configured = settings.host.trim().length > 0;
  // Gate the OpenPuck/Utilities card on the same opt-in pref the Setup surface
  // uses, so this firmware-flashing card is OFF by default in Actions too (a
  // flashing surface never shows unasked). Turn it on in Setup → "Utilities
  // (advanced)"; that one switch now controls both places.
  const utilitiesEnabled = usePref('utilitiesEnabled');

  const actions = usePoll<{ actions: ActionInfo[] }>(
    () => api.actions(settings),
    30000,
    ready && configured,
    hostKey(settings), // clear the previous box's actions on switch
  );

  // The Steam settings shortcuts used to live here as a sub-tab, and were even
  // the DEFAULT one — so opening Actions landed on Steam rather than actions.
  // They now have their own segment on the Pad tab, one swipe past Remote, which
  // is where the everyday reason to reach them already is. Two routes to the
  // same panel is the duplication this app has been getting feedback about, so
  // this screen keeps only what it is named for. The panel itself is unchanged
  // and still lives in components/SteamMenusPanel, driven by the Pad tab's own
  // poll — nothing was deleted, only the second door.

  const execute = useCallback(
    async (action: ActionInfo) => {
      hapticHeavy();
      setRun({ action, running: true });
      try {
        const result = await api.runAction(settings, action.id);
        setRun({ action, result, running: false });
        if (result.ok) hapticSuccess();
        else hapticError();
      } catch (e: unknown) {
        setRun({
          action,
          error: e instanceof Error ? e.message : String(e),
          running: false,
        });
        hapticError();
      }
    },
    [settings],
  );

  const onTap = useCallback(
    (action: ActionInfo) => {
      hapticLight();
      confirm(action.label, `${action.description}\n\nRun this action?`, () => {
        if (action.danger === 'high') {
          // One confirm, then a cancellable countdown — not a second blind dialog.
          setPending({ action, secs: COUNTDOWN_SECS });
        } else {
          execute(action);
        }
      });
    },
    [execute],
  );

  // Tick the pending countdown once a second; fire the action when it reaches
  // zero. `execute` is read through a ref so that a `settings` change (e.g. a
  // background caps write, which re-memoizes execute) cannot re-arm the timer
  // mid-count — that would reset the current second and, if it churned faster
  // than 1/s, stall the countdown so it never fires. The effect depends on
  // `pending` alone; Cancel / box-switch / tab-blur all clear it (below).
  const executeRef = useRef(execute);
  executeRef.current = execute;
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => {
      if (pending.secs <= 1) {
        const a = pending.action;
        setPending(null);
        executeRef.current(a);
      } else {
        setPending({ action: pending.action, secs: pending.secs - 1 });
      }
    }, 1000);
    return () => clearTimeout(id);
  }, [pending]);

  // Switching boxes must abort a pending countdown — otherwise it would fire on
  // whatever box is now selected, the exact wrong-box mistake this guards against.
  const hk = hostKey(settings);
  useEffect(() => { setPending(null); }, [hk]);

  // Leaving the Actions tab also aborts it. Tab screens are FROZEN, not
  // unmounted, so a plain effect's cleanup never runs on blur — the setTimeout
  // would keep counting under react-freeze and fire on a tab the user already
  // left, with no visible countdown to cancel. useFocusEffect's cleanup runs on
  // blur: walk away and nothing destructive happens.
  useFocusEffect(useCallback(() => () => setPending(null), []));

  // "suspend" is handled by the Console tab's power control, which pairs it
  // with the Wake-on-LAN wake button and the wired-only guard, so it is left
  // out of the generic action list here to keep one safe entry point.
  const groups = DANGER_ORDER.map((danger) => ({
    danger,
    items: (actions.data?.actions ?? []).filter(
      (a) => a.danger === danger && a.id !== 'suspend',
    ),
  })).filter((g) => g.items.length > 0);

  // Let the feature tour scroll a group into view before spotlighting it: with
  // the boot-session card above them, ENDS YOUR SESSION is below the fold on a
  // phone, and a spotlight cut over an off-screen group is a hole around nothing.
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  useEffect(
    () =>
      registerScroller('actions', (dy) => {
        scrollRef.current?.scrollTo({ y: Math.max(0, scrollY.current + dy), animated: true });
      }),
    [],
  );

  // --- Actions section layout: hold-to-edit reorder + hide (persisted) ------
  // The movable "cards" are the Boot Session card and the three impact groups.
  // Utilities is NOT movable (pinned above). Same store/pattern as the Console:
  // long-press a section (or tap Customize) to enter, ↑ ↓ / hide, then Done.
  const layout = useActionsLayout();
  const [editing, setEditing] = useState(false);
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const order = effectiveOrder(layout.order, [...SECTION_ORDER]);
  const hidden = new Set(layout.hidden);
  const setPres = (id: string, p: boolean) =>
    setPresent((prev) => (prev[id] === p ? prev : { ...prev, [id]: p }));
  const visible = order.filter((id) => present[id]);
  const moveCard = (id: string, dir: -1 | 1) =>
    setActionsLayout({ order: moveSection(order, visible, id, dir), hidden: layout.hidden });
  const toggleHide = (id: string) => {
    const h = new Set(layout.hidden);
    if (h.has(id)) h.delete(id); else h.add(id);
    setActionsLayout({ order, hidden: [...h] });
  };

  // The impact groups by section id (undefined when the box reports none of that
  // level — the section then renders null and shows no edit controls).
  const groupById: Record<string, { danger: Danger; items: ActionInfo[] } | undefined> = {
    routine: groups.find((g) => g.danger === 'low'),
    medium: groups.find((g) => g.danger === 'medium'),
    high: groups.find((g) => g.danger === 'high'),
  };
  const renderGroup = (g: { danger: Danger; items: ActionInfo[] }) => (
    // TourAnchor REPLACES the group's View and inherits styles.group, so the
    // layout and the tour anchor are unchanged by the wrapping EditableSection.
    <TourAnchor id={TOUR_ANCHOR[g.danger]} style={styles.group}>
      <Text style={[styles.groupTitle, { color: DANGER_COLOR[g.danger] }]}>
        {GROUP_TITLE[g.danger]}
      </Text>
      {g.items.map((a) => (
        <Pressable
          key={a.id}
          onPress={() => onTap(a)}
          style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
          <View style={styles.cardHead}>
            <Text style={styles.cardLabel}>{a.label}</Text>
            {a.danger === 'high' && (
              <View style={[styles.badge, { backgroundColor: DANGER_COLOR[a.danger] }]}>
                {/* The badge's fill is per-danger (red/amber/green), so its text is
                    chosen for contrast against THAT fill, not a fixed on-red. */}
                <Text style={[styles.badgeText, { color: textOn(DANGER_COLOR[a.danger], t) }]}>{BADGE_TEXT[a.danger]}</Text>
              </View>
            )}
          </View>
        </Pressable>
      ))}
    </TourAnchor>
  );
  const sectionNodes: Record<string, React.ReactNode> = {
    boot: configured ? <BootSessionCard /> : null,
    routine: groupById.routine ? renderGroup(groupById.routine) : null,
    medium: groupById.medium ? renderGroup(groupById.medium) : null,
    high: groupById.high ? renderGroup(groupById.high) : null,
  };
  const renderSection = (id: string) => {
    const node = sectionNodes[id];
    if (node == null) return null;
    return (
      <EditableSection
        key={id}
        editing={editing}
        hidden={hidden.has(id)}
        isFirst={visible[0] === id}
        isLast={visible[visible.length - 1] === id}
        onEnterEdit={() => setEditing(true)}
        onPresent={(p) => setPres(id, p)}
        onUp={() => moveCard(id, -1)}
        onDown={() => moveCard(id, 1)}
        onToggleHide={() => toggleHide(id)}
        inertWhileEditing>
        {node}
      </EditableSection>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: 12 }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Actions</Text>
        {/* CUSTOMIZE: a visible way into hold-to-edit, and the way back in when a
            section is hidden. Gone while editing — the Done bar owns the exit. */}
        {configured && !editing && (
          <Pressable
            onPress={() => { hapticSelection(); setEditing(true); }}
            accessibilityRole="button"
            accessibilityLabel="Reorder or hide sections"
            hitSlop={8}
            style={({ pressed }) => [styles.customizeBtn, pressed && styles.pressed]}>
            <Ionicons name="options-outline" size={18} color={t.textDim} />
          </Pressable>
        )}
      </View>
      <ScrollView
        ref={scrollRef}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        style={styles.list}
        contentContainerStyle={{ paddingBottom: 12 }}>
        {/* Fresh install: nothing paired yet, so nothing is "unreachable". */}
        {!configured && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No box configured</Text>
            <Text style={styles.emptyText}>
              Open the Setup tab to pair with the Couchside service on your media center,
              Steam machine, or PC — then add your TV for one remote that drives both.
            </Text>
          </View>
        )}
        {configured && actions.error != null && !actions.data && (
          <View style={styles.errBox}>
            <Text style={styles.errText}>{actions.error.message}</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
              onPress={actions.refresh}>
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
          </View>
        )}
        {configured && !actions.data && actions.error == null && (
          <Text style={styles.dim}>loading…</Text>
        )}
        {/* OpenPuck flasher, surfaced here for quick reach (also lives under
            Setup → Utilities). OPT-IN: gated on the same `utilitiesEnabled`
            pref as the Setup surface, OFF by default, so it no longer shows
            unasked. Self-hides on boxes without the utilities endpoint too.
            PINNED above the movable sections — an advanced flashing tool is not
            something to reorder or hide by accident. */}
        {configured && utilitiesEnabled && <UtilitiesSection context="actions" />}
        {/* Movable sections — the Boot Session card and the three impact groups —
            with hold-to-edit reorder + hide (Customize in the header, Done bar
            below). Each is inert while editing so a tap lands on the reorder/hide
            strip, not on a card or an action. renderSection returns null for a
            section the box has nothing for, so its edit controls never orphan.
            The group blocks keep their tour anchors (actions.routine/medium/high),
            matching lib/tour.ts; a group with no items renders null and that tour
            step skips itself rather than pointing at a header that is not there. */}
        {configured && order.map((id) => renderSection(id))}
      </ScrollView>

      {/* Edit-layout bar: hold any section (or tap Customize) to enter; reorder /
          hide, then Done. Matches the Console tab. */}
      {editing && (
        <View style={styles.editBar}>
          <Text style={styles.editHint}>Reorder or hide sections</Text>
          <Pressable
            onPress={() => setEditing(false)}
            accessibilityRole="button"
            accessibilityLabel="Done editing actions"
            style={({ pressed }) => [styles.doneBtn, pressed && styles.pressed]}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      )}

      {/* Countdown before a session-ending action fires */}
      {pending && (
        <View style={styles.countdownPanel}>
          <View style={styles.countdownText}>
            <Text style={styles.countdownTitle} numberOfLines={1}>
              {pending.action.label} in {pending.secs}s
            </Text>
            <Text style={styles.countdownSub} numberOfLines={1}>
              on {settings.host}
            </Text>
          </View>
          <Pressable
            onPress={() => { hapticLight(); setPending(null); }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Cancel ${pending.action.label}`}
            style={({ pressed }) => [styles.countdownCancel, pressed && styles.pressed]}>
            <Text style={styles.countdownCancelText}>CANCEL</Text>
          </Pressable>
        </View>
      )}

      {/* Result panel */}
      {run && (
        <View style={styles.resultPanel}>
          <View style={styles.resultHead}>
            <Text style={styles.resultTitle}>
              {run.action.label} {run.running ? '· running…' : ''}
            </Text>
            {!run.running && (
              <Pressable onPress={() => setRun(null)} hitSlop={12}>
                <Text style={styles.resultClose}>✕</Text>
              </Pressable>
            )}
          </View>
          {run.error != null && <Text style={styles.resultErr}>{run.error}</Text>}
          {run.result && (
            <>
              <Text
                style={[
                  styles.resultExit,
                  { color: run.result.ok ? t.green : t.red },
                ]}>
                exit {run.result.exit_code} · {run.result.duration_ms}ms ·{' '}
                {run.result.ok ? 'OK' : 'FAILED'}
              </Text>
              <ScrollView style={styles.resultScroll}>
                {run.result.stdout ? (
                  <Text style={styles.resultOut}>{run.result.stdout}</Text>
                ) : null}
                {run.result.stderr ? (
                  <Text style={[styles.resultOut, { color: t.red }]}>
                    {run.result.stderr}
                  </Text>
                ) : null}
                {!run.result.stdout && !run.result.stderr ? (
                  <Text style={styles.dimMono}>(no output)</Text>
                ) : null}
              </ScrollView>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  title: { color: t.text, fontSize: 26, fontWeight: '700', marginBottom: 12, fontFamily: mono },
  customizeBtn: { marginLeft: 'auto', marginBottom: 12, padding: 6, borderRadius: 8 },
  editBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28,
    backgroundColor: t.card, borderTopColor: t.cardBorder, borderTopWidth: 1,
  },
  editHint: { color: t.textDim, fontSize: 13 },
  doneBtn: {
    backgroundColor: t.blue, borderRadius: 999,
    paddingVertical: 8, paddingHorizontal: 22,
  },
  doneText: { color: t.onAccent, fontWeight: '700', fontSize: 14 },
  list: { flex: 1 },
  group: { marginBottom: 16 },
  groupTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  cardLabel: { color: t.text, fontSize: 16, fontWeight: '700', flex: 1 },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { color: t.onRed, fontSize: 11, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  emptyCard: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  emptyTitle: { color: t.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  emptyText: { color: t.textDim, fontSize: 13, lineHeight: 19 },
  errBox: {
    backgroundColor: t.redDeep,
    borderColor: t.red,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  errText: { color: t.onRedDeep, fontSize: 13, marginBottom: 8 },
  retryBtn: {
    backgroundColor: t.red,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 8,
  },
  retryText: { color: t.onRed, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  dim: { color: t.textDim, fontSize: 13 },
  dimMono: { color: t.textFaint, fontSize: 12, fontFamily: mono },
  resultPanel: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    maxHeight: 240,
  },
  resultHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  resultTitle: { color: t.text, fontSize: 14, fontWeight: '700', flex: 1 },
  resultClose: { color: t.textDim, fontSize: 16, padding: 4 },
  resultExit: { fontSize: 12, marginBottom: 6, ...numeric },
  resultErr: { color: t.red, fontSize: 13, fontFamily: mono },
  resultScroll: { maxHeight: 150 },
  resultOut: { color: t.textDim, fontSize: 12, fontFamily: mono, lineHeight: 17 },
  countdownPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: t.redDeep,
    borderColor: t.red,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  countdownText: { flex: 1 },
  countdownTitle: { color: t.onRedDeep, fontSize: 15, fontWeight: '800' },
  countdownSub: { color: t.onRedDeep, opacity: 0.8, fontSize: 12, marginTop: 2, fontFamily: mono },
  countdownCancel: {
    backgroundColor: t.red,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 8,
  },
  countdownCancelText: { color: t.onRed, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
});
