/**
 * The library filter sheet — phase 1 of docs/memory/project_library-triage.md.
 *
 * THE DETAIL THAT MAKES IT WORK is the confirm button: it is a LIVE COUNT that
 * falls as you narrow ("SHOW 272 GAMES" → "SHOW 8 GAMES"). Borrowed from
 * DeckFilter, where it turns filtering from a chore into the interaction itself.
 * The count is computed from the SAME predicate the list uses, so the button can
 * never promise a number the screen then contradicts.
 *
 * Search deliberately lives on the SCREEN, not in here: the Launch tab already
 * has a search box whose matching ignores whitespace ("deadcells" finds "Dead
 * Cells"). Two fields would be clutter and duplicating it would regress that.
 * The count below still reflects the active query, because the caller passes in
 * the already-searched list.
 *
 * Everything here filters on data the box already sent — launcher kind and the
 * playtime Steam recorded on the machine. No network, no Steam API key.
 * Compatibility filters (ProtonDB, Deck Verified) need the internet and are
 * phase 2, deliberately absent rather than stubbed.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, TextInput } from 'react-native';

import { deletePreset, savePreset, useLibraryMarks } from '@/hooks/useLibraryMarks';
import { hapticLight, hapticSelection } from '@/lib/haptics';
import {
  countLabel,
  countMatching,
  EMPTY_FILTER,
  hasPlaytimeData,
  isFiltering,
  presetName,
  type FilterableGame,
  type FilterState,
  type PlayedFilter,
} from '@/lib/libraryFilter';
import type { Compat, DeckStatus, ProtonTier } from '@/lib/compat';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const SIZES: { gb: number; label: string }[] = [
  { gb: 10, label: 'Over 10 GB' },
  { gb: 25, label: 'Over 25 GB' },
  { gb: 50, label: 'Over 50 GB' },
];

const PLAYED: { id: PlayedFilter; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'never', label: 'Never played' },
  { id: 'under2h', label: 'Under 2h' },
  { id: 'over2h', label: '2h or more' },
];

const KINDS: { id: 'steam' | 'custom' | 'shortcut'; label: string }[] = [
  { id: 'steam', label: 'Steam' },
  { id: 'shortcut', label: 'Shortcuts' },
  { id: 'custom', label: 'Custom' },
];

const DECK: { id: DeckStatus; label: string }[] = [
  { id: 'verified', label: 'Verified' },
  { id: 'playable', label: 'Playable' },
  { id: 'unsupported', label: 'Unsupported' },
];

const PROTON: { id: ProtonTier; label: string }[] = [
  { id: 'platinum', label: 'Platinum' },
  { id: 'gold', label: 'Gold' },
  { id: 'silver', label: 'Silver' },
  { id: 'bronze', label: 'Bronze' },
  { id: 'borked', label: 'Borked' },
];

const STALE: { days: number; label: string }[] = [
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: 'a year' },
];

function Chip({
  onLongPress,
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  /** Only the saved-preset chips use this — hold to delete. */
  onLongPress?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function LibraryFilterSheet({
  visible,
  games,
  value,
  compat,
  compatOn,
  onChange,
  onClose,
}: {
  visible: boolean;
  games: (FilterableGame & { appid?: number })[];
  value: FilterState;
  compat?: Record<number, Compat>;
  /** Compatibility lookups are opt-in; without them these chips would be dead
   *  controls that silently match everything. */
  compatOn?: boolean;
  onChange: (f: FilterState) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const marks = useLibraryMarks();
  const [presetDraft, setPresetDraft] = useState('');

  // Same predicate the list runs, so the button cannot lie about the result.
  const nowSec = Math.floor(Date.now() / 1000);
  // The bookmark set feeds the count too, or the button would promise a number
  // the grid then contradicts the moment "Bookmarked" is on.
  const count = useMemo(
    () => countMatching(games, value, nowSec, compat, marks.bookmarks),
    [games, value, nowSec, compat, marks.bookmarks],
  );
  const active = isFiltering(value);
  // See hasPlaytimeData: on an older agent every game looks unplayed, so these
  // controls would state something false about the user's library.
  const playtime = useMemo(() => hasPlaytimeData(games), [games]);
  // Probe-and-appear, like playtime: an agent older than 2.9.72 sends no sizes,
  // and a size filter would then be a control that silently matches everything.
  const sizes = useMemo(() => games.some((g) => (g.size_bytes ?? 0) > 0), [games]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close filters"
              style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}>
              <Ionicons name="close" size={18} color={t.textDim} />
            </Pressable>
            <Text style={styles.headTitle}>Filter library</Text>
            <Pressable
              onPress={() => {
                hapticLight();
                onChange(EMPTY_FILTER);
              }}
              disabled={!active}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Reset filters"
              style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}>
              <Ionicons name="refresh" size={16} color={active ? t.textDim : t.textFaint} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {/* Bookmarks first: it is the one filter whose answer the user
                authored themselves, so it is the fastest way to a short list. */}
            <Text style={styles.label}>BOOKMARKS</Text>
            <View style={styles.row}>
              <Chip
                label={marks.bookmarks.size ? `Bookmarked · ${marks.bookmarks.size}` : 'Bookmarked'}
                on={value.bookmarked === true}
                onPress={() =>
                  onChange({ ...value, bookmarked: value.bookmarked ? undefined : true })
                }
              />
            </View>
            {value.bookmarked && marks.bookmarks.size === 0 ? (
              <Text style={styles.note}>
                Nothing bookmarked yet — tap a game, then Bookmark, to start a shortlist.
              </Text>
            ) : null}

            {marks.presets.length ? (
              <>
                <Text style={styles.label}>SAVED</Text>
                <View style={styles.row}>
                  {marks.presets.map((p) => (
                    <Chip
                      key={p.name}
                      label={p.name}
                      on={false}
                      // A COPY, not the stored object: the live filter is then
                      // spread and rebuilt as the user taps, and sharing the
                      // reference would let that edit the saved preset in place.
                      onPress={() => onChange({ ...p.filter, kinds: [...p.filter.kinds] })}
                      onLongPress={() => {
                        hapticLight();
                        deletePreset(p.name);
                      }}
                    />
                  ))}
                </View>
                <Text style={styles.note}>Tap to apply · hold to delete.</Text>
              </>
            ) : null}

            {active ? (
              <View style={styles.row}>
                <TextInput
                  value={presetDraft}
                  onChangeText={setPresetDraft}
                  placeholder="Save this filter as…"
                  placeholderTextColor={t.textFaint}
                  style={styles.presetInput}
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    if (!presetName(presetDraft)) return;
                    hapticLight();
                    savePreset(presetDraft, value);
                    setPresetDraft('');
                  }}
                />
                <Pressable
                  onPress={() => {
                    if (!presetName(presetDraft)) return;
                    hapticLight();
                    savePreset(presetDraft, value);
                    setPresetDraft('');
                  }}
                  disabled={!presetName(presetDraft)}
                  accessibilityRole="button"
                  accessibilityLabel="Save this filter"
                  style={({ pressed }) => [
                    styles.chip,
                    presetName(presetDraft) ? styles.chipOn : null,
                    pressed && styles.pressed,
                  ]}>
                  <Text style={[styles.chipText, presetName(presetDraft) ? styles.chipTextOn : null]}>
                    SAVE
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {playtime ? (
              <>
            <Text style={styles.label}>PLAYTIME</Text>
            <View style={styles.row}>
              {PLAYED.map((p) => (
                <Chip
                  key={p.id}
                  label={p.label}
                  on={value.played === p.id}
                  onPress={() => onChange({ ...value, played: p.id })}
                />
              ))}
            </View>

            <Text style={styles.label}>NOT PLAYED IN</Text>
            <View style={styles.row}>
              {STALE.map((s) => (
                <Chip
                  key={s.days}
                  label={s.label}
                  on={value.staleDays === s.days}
                  // Tapping the active one clears it — a filter you cannot turn
                  // off without hunting for Reset is a trap.
                  onPress={() =>
                    onChange({ ...value, staleDays: value.staleDays === s.days ? 0 : s.days })
                  }
                />
              ))}
            </View>

              </>
            ) : (
              <Text style={styles.note}>
                Playtime filters need the Couchside service 2.9.71 or newer on the box.
              </Text>
            )}

            {compatOn ? (
              <>
                <Text style={styles.label}>STEAM DECK</Text>
                <View style={styles.row}>
                  {DECK.map((d) => (
                    <Chip
                      key={d.id}
                      label={d.label}
                      on={(value.deck ?? []).includes(d.id)}
                      onPress={() =>
                        onChange({
                          ...value,
                          deck: (value.deck ?? []).includes(d.id)
                            ? (value.deck ?? []).filter((x) => x !== d.id)
                            : [...(value.deck ?? []), d.id],
                        })
                      }
                    />
                  ))}
                </View>

                <Text style={styles.label}>PROTONDB</Text>
                <View style={styles.row}>
                  {PROTON.map((pt) => (
                    <Chip
                      key={pt.id}
                      label={pt.label}
                      on={(value.proton ?? []).includes(pt.id)}
                      onPress={() =>
                        onChange({
                          ...value,
                          proton: (value.proton ?? []).includes(pt.id)
                            ? (value.proton ?? []).filter((x) => x !== pt.id)
                            : [...(value.proton ?? []), pt.id],
                        })
                      }
                    />
                  ))}
                </View>
                {/* Unrated games are never hidden by these — see matchesCompat. */}
                <Text style={styles.note}>Games nobody has rated always stay visible.</Text>
              </>
            ) : null}

            {/* SPACE — the "what is eating my disk" half of triage. Pairs with
                PLAYTIME above: big + never played is the actual question. */}
            {sizes ? (
              <>
                <Text style={styles.label}>ON DISK</Text>
                <View style={styles.row}>
                  {SIZES.map((sz) => (
                    <Chip
                      key={sz.gb}
                      label={sz.label}
                      on={value.minSizeGb === sz.gb}
                      onPress={() =>
                        onChange({
                          ...value,
                          minSizeGb: value.minSizeGb === sz.gb ? undefined : sz.gb,
                        })
                      }
                    />
                  ))}
                </View>
                <Text style={styles.note}>
                  Only games Steam has measured. Shortcuts have no install size.
                </Text>
              </>
            ) : null}

            <Text style={styles.label}>TYPE</Text>
            <View style={styles.row}>
              {KINDS.map((k) => (
                <Chip
                  key={k.id}
                  label={k.label}
                  on={value.kinds.includes(k.id)}
                  onPress={() =>
                    onChange({
                      ...value,
                      kinds: value.kinds.includes(k.id)
                        ? value.kinds.filter((x) => x !== k.id)
                        : [...value.kinds, k.id],
                    })
                  }
                />
              ))}
            </View>
          </ScrollView>

          <Pressable
            onPress={() => {
              hapticLight();
              onClose();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.confirm,
              count === 0 && styles.confirmEmpty,
              pressed && styles.pressed,
            ]}>
            <Text style={[styles.confirmText, count === 0 && styles.confirmTextEmpty]}>
              {countLabel(count)}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: '#000a', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: t.bg,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      borderTopWidth: 1,
      borderColor: t.cardBorder,
      maxHeight: '85%',
      paddingBottom: 28,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.cardBorder,
    },
    headTitle: { color: t.text, fontSize: 14, fontWeight: '800', fontFamily: mono },
    iconBtn: { padding: 6 },
    body: { padding: 14, gap: 10 },
    label: {
      color: t.textDim,
      fontSize: 11,
      letterSpacing: 1,
      fontFamily: mono,
      marginTop: 6,
    },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    presetInput: {
      flex: 1,
      minWidth: 140,
      color: t.text,
      fontSize: 12,
      fontFamily: mono,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: t.cardBorder,
      backgroundColor: t.inset,
    },
    note: { color: t.textFaint, fontSize: 12, lineHeight: 17, marginTop: 4 },
    chip: {
      paddingVertical: 8,
      paddingHorizontal: 13,
      borderRadius: 999,
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    chipOn: { borderColor: t.blue, backgroundColor: t.blue + '22' },
    chipText: { color: t.textDim, fontSize: 12, fontFamily: mono },
    chipTextOn: { color: t.blue, fontWeight: '800' },
    confirm: {
      marginHorizontal: 14,
      marginTop: 4,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      backgroundColor: t.green,
    },
    confirmEmpty: { backgroundColor: t.inset, borderWidth: 1, borderColor: t.cardBorder },
    confirmText: { color: '#04140c', fontSize: 14, fontWeight: '900', letterSpacing: 1, fontFamily: mono },
    confirmTextEmpty: { color: t.textDim },
    pressed: { opacity: 0.6 },
  });
