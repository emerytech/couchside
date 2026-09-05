import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EditableSection } from '@/components/EditableSection';
import { Gated } from '@/components/Gated';
import { TourAnchor } from '@/components/TourAnchor';
import { registerScroller } from '@/hooks/useTourAnchor';
import { DisplayAudioCard } from '@/components/DisplayAudioCard';
import { AudioOutputCard } from '@/components/AudioOutputCard';
import { RgbLedCard } from '@/components/RgbLedCard';
import { StripLightCard } from '@/components/StripLightCard';
import { OpenRgbCard } from '@/components/OpenRgbCard';
import { FileDropCard } from '@/components/FileDropCard';
import { GamingCard } from '@/components/GamingCard';
import { NowPlayingCard } from '@/components/NowPlayingCard';
import { ScreenPreview } from '@/components/ScreenPreview';
import { StreakCelebration } from '@/components/StreakCard';
import { StreamHostCard } from '@/components/StreamHostCard';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { useStreak } from '@/hooks/useStreak';
import { api, hostKey, humanizeUptime, Status, Unit } from '@/lib/api';
import { fmtLastSeen, noteBoxSeen } from '@/lib/lastSeen';
import { useConsoleLayout, effectiveOrder, moveSection, setConsoleLayout } from '@/lib/consoleLayout';
import { hapticSelection } from '@/lib/haptics';
import { setPref, usePref } from '@/lib/prefs';
import { useSkinKit, VitalsContext, vitality } from '@/lib/skin';
import { noteBoxReachable } from '@/lib/review';
import { useSettings } from '@/lib/SettingsContext';
import { batteryColor, mono, numeric, pctColor, tempColor, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

function unitColor(active: string, t: Palette): string {
  if (active === 'active') return t.green;
  if (active === 'failed') return t.red;
  return t.amber;
}

function UnitChip({ unit }: { unit: Unit }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const color = unitColor(unit.active, t);
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <View style={[styles.chipDot, { backgroundColor: color }]} />
      <Text style={styles.chipName} numberOfLines={1}>
        {unit.name.replace(/\.service$/, '')}
      </Text>
      <Text style={[styles.chipState, { color }]}>
        {unit.active}
        {unit.sub ? `/${unit.sub}` : ''}
      </Text>
    </View>
  );
}

/** "1h 24m" / "40m" — minutes only under an hour, so a short charge does not
 *  read as "0h 40m". */
function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function ConsoleTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <ConsoleScreen />
      </Gated>
    </TabScreen>
  );
}

function ConsoleScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Screen, Card, Bar, Dot, Spark, BigMetric } = useSkinKit();
  const { settings, ready, update } = useSettings();

  // No host yet (fresh install): don't poll, and show the pairing hint
  // instead of the unreachable banner.
  const configured = settings.host.trim().length > 0;

  const statusInterval = usePref('statusIntervalMs');
  const boxKey = hostKey(settings); // resetKey: clear stale data on box switch
  const status = usePoll<Status>(
    () => api.status(settings), statusInterval, ready && configured, boxKey);
  const units = usePoll<{ units: Unit[] }>(
    () => api.units(settings), 10000, ready && configured, boxKey);

  const s = status.data;
  const reachable = configured && status.error == null && s != null;
  // Counted only once the box has actually ANSWERED — an app opened to find the
  // box dead must not be congratulated for it.
  const streakEnabled = usePref('streakCelebrations');
  const streak = useStreak(reachable, streakEnabled);
  // Show the 60s average, not the 10s: a momentary spike while a game loads is
  // normal and not worth a number that jumps every poll. Only surfaced once it
  // is above a floor, so an idle box stays quiet.
  const memPressure =
    s?.mem.pressure?.some60 != null && s.mem.pressure.some60 >= 1 ? s.mem.pressure.some60 : null;
  const memPct = s ? Math.round((s.mem.used_mb / s.mem.total_mb) * 100) : 0;

  // The app did its job: a paired box answered. Counted at most once per launch
  // (noteBoxReachable guards); at EARNED_SESSIONS it earns a review ask.
  useEffect(() => {
    if (reachable) void noteBoxReachable();
  }, [reachable]);

  // Persist a per-box "last seen" so the unreachable banner shows a real elapsed
  // time after an app restart or box switch instead of "never" — usePoll's
  // in-memory lastSuccess is null on a cold launch to a dead box and is cleared
  // on every box switch. Throttled in noteBoxSeen; keyed by boxKey so switching
  // boxes records the newly-active one promptly.
  useEffect(() => {
    if (status.lastSuccess != null) {
      noteBoxSeen(boxKey, status.lastSuccess, (ts) => void update({ lastSeen: ts }));
    }
  }, [status.lastSuccess, boxKey, update]);

  // How hard the box is working, 0..1. Skins use this to set the RATE of their
  // idle motion -- a busy box breathes faster. Never a colour input.
  const vitals = React.useMemo(
    () => ({ v: vitality(s?.load?.[0], s?.cpu_temp_c), alive: reachable }),
    [s?.load, s?.cpu_temp_c, reachable],
  );

  // Let the feature tour scroll a card into view before spotlighting it: the
  // screen preview and display info both sit below the fold on a phone, and a
  // spotlight cut over an off-screen element is a hole around nothing.
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  useEffect(
    () =>
      registerScroller('index', (dy) => {
        scrollRef.current?.scrollTo({ y: Math.max(0, scrollY.current + dy), animated: true });
      }),
    [],
  );

  // --- Console card layout: hold-to-edit reorder + hide (persisted) --------
  const CARD_ORDER_CANON = [
    'nowplaying', 'streamhost', 'gaming', 'vitals', 'screen', 'display', 'audio', 'leds', 'stripleds', 'openrgb', 'units', 'filedrop',
  ];
  const cardLayout = useConsoleLayout();
  const [editingCards, setEditingCards] = useState(false);
  const [cardPresent, setCardPresent] = useState<Record<string, boolean>>({});
  const cardOrder = effectiveOrder(cardLayout.order, CARD_ORDER_CANON);
  const cardHidden = new Set(cardLayout.hidden);
  const setPresent = (id: string, p: boolean) =>
    setCardPresent((prev) => (prev[id] === p ? prev : { ...prev, [id]: p }));
  // FOCUSED DEFAULT (App Store review, 2026-08-30: "the UI is a little busy").
  // Cards split into what is happening NOW (media, a stream, a game, the box's
  // vitals) and the box's CONTROLS & TOOLS (lights, display/audio, screen,
  // units, file drop). Status stays in the main flow; the tools fold behind one
  // "More" row, collapsed by default. Folding is NOT hiding: a folded card still
  // exists and opens in one tap, where a hidden one leaves you wondering where
  // it went. The split is by card id, so a user's saved order is respected
  // inside each group and reorder moves stay within a group. The fold is forced
  // open while editing so every card — hidden ones included — is reachable.
  const MORE_IDS = new Set(['screen', 'display', 'audio', 'leds', 'stripleds', 'openrgb', 'units', 'filedrop']);
  const primaryOrder = cardOrder.filter((id) => !MORE_IDS.has(id));
  const moreOrder = cardOrder.filter((id) => MORE_IDS.has(id));
  const moreCollapsedPref = usePref('consoleMoreCollapsed');
  const moreOpen = editingCards || !moreCollapsedPref;
  const visibleIn = (ids: string[]) => ids.filter((id) => cardPresent[id]);
  const moveCard = (id: string, dir: -1 | 1) => {
    const group = MORE_IDS.has(id) ? moreOrder : primaryOrder;
    setConsoleLayout({ order: moveSection(cardOrder, visibleIn(group), id, dir), hidden: cardLayout.hidden });
  };
  const toggleHideCard = (id: string) => {
    const h = new Set(cardLayout.hidden);
    if (h.has(id)) h.delete(id); else h.add(id);
    setConsoleLayout({ order: cardOrder, hidden: [...h] });
  };

  // The movable cards, by id. null = not applicable on this box/state (skipped).
  // The self-gating (probe-and-appear) cards render null internally when absent;
  // EditableSection then shows no edit controls for them.
  const cardNodes: Record<string, React.ReactNode> = {
    nowplaying: <NowPlayingCard />,
    streamhost: <StreamHostCard />,
    gaming: <GamingCard />,
    vitals: s ? (
      <>
        <View style={styles.row}>
          {/* TourAnchor REPLACES the half View rather than wrapping it, so
              the flex row is untouched — see components/TourAnchor.tsx. */}
          <TourAnchor id="console.cpu" style={styles.half}>
            <Card title="CPU TEMP" index={0}>
              <BigMetric
                value={s.cpu_temp_c != null ? `${s.cpu_temp_c.toFixed(1)}°C` : '—'}
                numeric={s.cpu_temp_c}
                color={tempColor(s.cpu_temp_c, t)}
              />
              <Spark values={s.history?.temp} color={tempColor(s.cpu_temp_c, t)} />
            </Card>
          </TourAnchor>
          <View style={styles.half}>
            <Card title="UPTIME" index={1}>
              <BigMetric value={humanizeUptime(s.uptime_s)} numeric={null} color={t.text} />
              {s.ip ? <Text style={styles.ipLine}>{s.ip}</Text> : null}
            </Card>
          </View>
        </View>

        <Card title="LOAD 1m / 5m / 15m" index={2}>
          <View style={styles.loadRow}>
            {s.load.map((l, i) => (
              <Text key={i} style={styles.loadVal}>
                {l.toFixed(2)}
              </Text>
            ))}
          </View>
          <Spark values={s.history?.load} color={t.blue} />
        </Card>

        <Card title="MEMORY" index={3}>
          <View style={styles.barLabelRow}>
            <Text style={styles.barLabel}>
              {(s.mem.used_mb / 1024).toFixed(1)} / {(s.mem.total_mb / 1024).toFixed(1)} GB
            </Text>
            <Text style={[styles.barLabel, { color: pctColor(memPct, t) }]}>{memPct}%</Text>
          </View>
          <Bar pct={memPct} color={pctColor(memPct, t)} />
          <Spark values={s.history?.mem_pct} color={pctColor(memPct, t)} min={0} max={100} />
          {(memPressure != null || (s.mem.swap_used_mb ?? 0) > 0) && (
            <Text style={styles.ipLine}>
              {[
                memPressure != null ? `stalled ${memPressure.toFixed(1)}%` : null,
                (s.mem.swap_used_mb ?? 0) > 0
                  ? `swap ${(s.mem.swap_used_mb! / 1024).toFixed(1)}G`
                  : null,
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </Text>
          )}
        </Card>

        <Card title="DISKS" index={4}>
          {s.disks.map((d) => (
            <View key={d.mount} style={styles.diskRow}>
              <View style={styles.barLabelRow}>
                <Text style={styles.diskMount}>{d.mount}</Text>
                <Text style={styles.barLabel}>
                  {d.used_gb.toFixed(1)} / {d.total_gb.toFixed(1)} GB
                  {'   '}
                  <Text style={{ color: pctColor(d.pct, t) }}>{d.pct}%</Text>
                </Text>
              </View>
              <Bar pct={d.pct} color={pctColor(d.pct, t)} />
            </View>
          ))}
        </Card>

        {/* Probe-and-appear: the agent OMITS `battery` on a mains desktop
            and on agents older than 2.9.40, so presence of the key is the
            whole gate -- no cap check, no placeholder, no "0%" on a machine
            that has no pack. */}
        {s.battery && (
          <Card title="BATTERY" index={5}>
            <View style={styles.barLabelRow}>
              <Text style={styles.barLabel}>
                {s.battery.status === 'Charging'
                  ? 'Charging'
                  : s.battery.on_ac
                    ? 'On AC'
                    : 'On battery'}
                {s.battery.minutes_to_full != null
                  ? `   ${fmtDuration(s.battery.minutes_to_full)} to full`
                  : s.battery.minutes != null
                    ? `   ${fmtDuration(s.battery.minutes)} left`
                    : ''}
              </Text>
              <Text style={[styles.barLabel, { color: batteryColor(s.battery.pct, t) }]}>
                {s.battery.pct}%
              </Text>
            </View>
            <Bar pct={s.battery.pct} color={batteryColor(s.battery.pct, t)} />
            {(s.battery.watts != null || s.battery.profile) && (
              <Text style={styles.ipLine}>
                {[
                  s.battery.watts != null
                    ? `${s.battery.watts.toFixed(1)}W ${
                        s.battery.status === 'Charging' ? 'in' : 'draw'
                      }`
                    : null,
                  s.battery.profile,
                ]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
            )}
          </Card>
        )}
      </>
    ) : null,
    screen: (
      <TourAnchor id="console.screen">
        <ScreenPreview />
      </TourAnchor>
    ),
    display: (
      <TourAnchor id="console.display">
        <DisplayAudioCard />
      </TourAnchor>
    ),
    audio: <AudioOutputCard />,
    leds: <RgbLedCard />,
    stripleds: <StripLightCard />,
    openrgb: <OpenRgbCard />,
    units: configured ? (
      <Card title="UNITS" index={5}>
        {units.error != null && !units.data ? (
          <Text style={styles.unitErr}>{units.error.message}</Text>
        ) : units.data ? (
          <View style={styles.chips}>
            {units.data.units.filter((u) => !u.log_only).map((u) => (
              <UnitChip key={`${u.scope}:${u.name}`} unit={u} />
            ))}
          </View>
        ) : (
          <Text style={styles.unitErr}>loading…</Text>
        )}
        <Text style={styles.unitHint}>
          {(s?.agent_version ?? '').endsWith('-win')
            ? 'watchlist: config.json in the Couchside folder on the box (units[]), then restart the agent'
            : 'watchlist: /etc/couchside/config.json on the box (units[]), then restart couchside.service'}
        </Text>
      </Card>
    ) : null,
    filedrop: <FileDropCard />,
  };

  // One group of movable cards (status or tools), each in EditableSection
  // (long-press → edit; ↑ ↓ hide). first/last are computed WITHIN the group so
  // the arrows never try to cross the fold. Self-gating cards still render null
  // internally when the box lacks the feature; EditableSection then shows no
  // controls for them.
  const renderCards = (group: string[]) => {
    const vis = visibleIn(group);
    return group.map((id) => {
      const node = cardNodes[id];
      if (node == null) return null;
      return (
        <EditableSection
          key={id}
          editing={editingCards}
          hidden={cardHidden.has(id)}
          isFirst={vis[0] === id}
          isLast={vis[vis.length - 1] === id}
          onEnterEdit={() => setEditingCards(true)}
          onPresent={(p) => setPresent(id, p)}
          onUp={() => moveCard(id, -1)}
          onDown={() => moveCard(id, 1)}
          onToggleHide={() => toggleHideCard(id)}>
          {node}
        </EditableSection>
      );
    });
  };

  return (
    <VitalsContext.Provider value={vitals}>
    <View style={styles.screen}>
      <ScrollView
        ref={scrollRef}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: 12,
          paddingBottom: 32,
          paddingHorizontal: 14,
        }}>
        <Screen>
        {/* Status header */}
        <View style={styles.header}>
          <Dot color={reachable ? t.green : t.red} size={14} live={reachable} />
          <Text style={styles.hostname}>
            {s?.hostname ?? (configured ? settings.host : 'Couchside')}
          </Text>
          <View style={styles.headerRight}>
            <Text style={styles.headerSub}>
              {reachable ? `service v${s?.agent_version}` : configured ? 'offline' : 'not set up'}
            </Text>
            {/* Which OS the box runs (agent >= 2.9.34). Absent on older agents
                and on any box that could not read /etc/os-release, so it is
                rendered only when the box actually said — never a placeholder.
                `version` already falls back to BUILD_ID agent-side, so a
                rolling distro reads "CachyOS rolling" and a point release
                "Bazzite 43". numberOfLines guards a long PRETTY_NAME (Fedora
                ships "Fedora Linux 43 (KDE Plasma)") from shoving the row. */}
            {reachable && !!s?.os?.name && (
              <Text style={styles.headerOs} numberOfLines={1}>
                {[s.os.name, s.os.version].filter(Boolean).join(' ')}
              </Text>
            )}
          </View>
          {/* CUSTOMIZE: a visible way into the layout editor. Hold-to-edit
              shipped long ago but is an invisible gesture nobody found (the
              review that called the UI busy never knew cards could be hidden).
              Long-press still works; this just makes the same mode discoverable.
              Gone while editing — the Done bar owns the exit. */}
          {configured && !editingCards && (
            <TourAnchor id="console.customize">
              <Pressable
                onPress={() => {
                  hapticSelection();
                  setEditingCards(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Customize which cards show"
                hitSlop={8}
                style={({ pressed }) => [styles.customizeBtn, pressed && styles.pressed]}>
                <Ionicons name="options-outline" size={18} color={t.textDim} />
              </Pressable>
            </TourAnchor>
          )}
        </View>

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

        {/* Milestone only, and inline — never a modal over the controls. */}
        {streak.milestone != null && (
          <StreakCelebration
            milestone={streak.milestone}
            best={streak.state.best}
            onDismiss={streak.ack}
          />
        )}

        {/* Unreachable banner: the whole point of this app. Wake lives in the
            top bar (RemotePowerBar), so this keeps just the retry. */}
        {configured && status.error != null && (
          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>BOX UNREACHABLE</Text>
            <Text style={styles.bannerDetail}>{status.error.message}</Text>
            <Text style={styles.bannerDetail}>
              last seen: {fmtLastSeen(status.lastSuccess ?? settings.lastSeen ?? null)}
            </Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
              onPress={() => {
                status.refresh();
                units.refresh();
              }}>
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
          </View>
        )}

        {/* Movable cards: order + hidden from the hold-to-edit layout pref.
            Each wrapped in EditableSection (long-press → edit; ↑ ↓ hide). The
            self-gating cards still render null internally when their box lacks
            the feature; EditableSection shows no controls for a null card. */}
        {renderCards(primaryOrder)}

        {/* MORE: the box's controls & tools, folded by default (see the layout
            note above). The row is the whole affordance — one tap opens it and
            the choice persists. Disabled while editing, when it is forced open
            so hidden tool cards stay reachable. */}
        {configured && moreOrder.length > 0 && (
          <TourAnchor id="console.more">
            <Pressable
              onPress={() => {
                hapticSelection();
                void setPref('consoleMoreCollapsed', !moreCollapsedPref);
              }}
              disabled={editingCards}
              accessibilityRole="button"
              accessibilityState={{ expanded: moreOpen }}
              accessibilityLabel={moreOpen ? 'Collapse more controls' : 'Show more controls'}
              style={({ pressed }) => [styles.foldRow, pressed && !editingCards && styles.pressed]}>
              <Ionicons name="options-outline" size={14} color={t.blue} />
              <Text style={styles.foldText}>MORE</Text>
              <Text style={styles.foldSub} numberOfLines={1}>controls &amp; tools</Text>
              <Ionicons
                name={moreOpen ? 'chevron-up' : 'chevron-down'}
                size={15}
                color={t.textDim}
              />
            </Pressable>
          </TourAnchor>
        )}
        {moreOpen && renderCards(moreOrder)}
        </Screen>
      </ScrollView>
      {/* Edit-layout bar: hold any card to enter, then reorder/hide + Done. */}
      {editingCards && (
        <View style={styles.editBar}>
          <Text style={styles.editHint}>Reorder or hide cards</Text>
          <Pressable
            onPress={() => setEditingCards(false)}
            accessibilityRole="button"
            accessibilityLabel="Done editing layout"
            style={({ pressed }) => [styles.doneBtn, pressed && styles.pressed]}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      )}
    </View>
    </VitalsContext.Provider>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },
  scroll: { flex: 1 },
  editBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28,
    backgroundColor: t.card, borderTopColor: t.cardBorder, borderTopWidth: 1,
  },
  editHint: { color: t.textDim, fontSize: 13 },
  // Header "customize" affordance: quiet on purpose — the point of this pass is
  // LESS chrome, so it is an icon at the header's edge, not a labelled button.
  customizeBtn: { marginLeft: 10, padding: 6, borderRadius: 8 },
  // The "More" fold row: reads as a section label, not a card, so it doesn't
  // add to the very stack it is there to shorten.
  foldRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 12, marginTop: 2, marginBottom: 10,
    borderRadius: 10, backgroundColor: t.inset,
  },
  foldText: { color: t.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  foldSub: { color: t.textFaint, fontSize: 12, flex: 1 },
  doneBtn: {
    backgroundColor: t.blue, borderRadius: 999,
    paddingVertical: 8, paddingHorizontal: 22,
  },
  doneText: { color: t.bg, fontWeight: '700', fontSize: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 10,
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  hostname: { color: t.text, fontSize: 26, fontWeight: '700', fontFamily: mono },
  headerRight: { marginLeft: 'auto', alignItems: 'flex-end', flexShrink: 1 },
  headerSub: { color: t.textDim, fontSize: 13 },
  // Dimmer and smaller than the service line: useful when you need it, quiet
  // when you do not.
  headerOs: { color: t.textFaint, fontSize: 11, fontFamily: mono, marginTop: 1 },
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
  banner: {
    backgroundColor: t.redDeep,
    borderColor: t.red,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    alignItems: 'center',
  },
  bannerTitle: {
    // Was '#fff', which is 1.45:1 on light's redDeep — the OFFLINE headline was
    // very nearly invisible in light mode.
    color: t.onRedDeep,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 6,
  },
  bannerDetail: { color: t.onRedDeep, fontSize: 13, ...numeric },
  retryBtn: {
    marginTop: 12,
    backgroundColor: t.red,
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 8,
  },
  retryText: { color: t.onRed, fontWeight: '800', fontSize: 15, letterSpacing: 1 },
  pressed: { opacity: 0.7 },
  row: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: {
    color: t.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  bigMetric: { fontSize: 28, fontWeight: '700', ...numeric },
  loadRow: { flexDirection: 'row', justifyContent: 'space-between' },
  // Deliberately quiet: the IP is reference information you go looking for,
  // not a vital you watch. Sized so it never competes with the uptime metric
  // above it.
  ipLine: {
    color: t.textFaint,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 2,
    ...numeric,
  },
  loadVal: {
    color: t.text,
    fontSize: 22,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
    ...numeric,
  },
  barLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  barLabel: { color: t.textDim, fontSize: 12, ...numeric },
  barTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: t.inset,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 5 },
  diskRow: { marginBottom: 12 },
  diskMount: { color: t.text, fontSize: 13, fontWeight: '600', fontFamily: mono },
  chips: { gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: t.inset,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipName: { color: t.text, fontSize: 13, fontFamily: mono, flexShrink: 1 },
  chipState: { fontSize: 12, marginLeft: 'auto', ...numeric },
  unitErr: { color: t.textDim, fontSize: 13 },
  unitHint: { color: t.textFaint, fontFamily: mono, fontSize: 10, marginTop: 10 },
});
