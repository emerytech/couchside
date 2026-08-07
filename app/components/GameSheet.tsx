/**
 * Tap-to-confirm and long-press-for-detail on a library tile.
 *
 * WHY THIS EXISTS: a tile launched the moment you touched it. Launching takes
 * over the television — it is not a preference toggle, and on a grid you scroll
 * with your thumb a stray tap starts a game on the TV across the room. Reported
 * by the owner: "annoyed me a few times already by accidentally launching a
 * game". A confirm step costs one deliberate tap and removes the whole class of
 * mistake.
 *
 * ONE GESTURE, ONE SHEET. An earlier draft split it — tap to confirm,
 * long-press for detail — and that was worse: two ways in, two states to reason
 * about, and a hidden gesture the user has to know exists. A tap opens the whole
 * thing, which both confirms the launch and answers "what is this, and have I
 * played it".
 *
 * Everything shown comes from what the box already sent. Nothing here fetches.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ImageSourcePropType } from 'react-native';

import { toggleBookmarked, useLibraryMarks } from '@/hooks/useLibraryMarks';
import { hapticLight } from '@/lib/haptics';
import type { Launcher } from '@/lib/api';
import { bookmarkKey, playtimeLabel } from '@/lib/libraryFilter';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** "3 days ago" / "today" / "never". Absent last_played is honest, not zero. */
function lastPlayedLabel(sec: number | undefined, nowSec: number): string {
  if (sec == null || sec <= 0) return 'never opened';
  const days = Math.floor((nowSec - sec) / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const m = Math.round(days / 30);
    return m === 1 ? 'a month ago' : `${m} months ago`;
  }
  const y = Math.round(days / 365);
  return y === 1 ? 'a year ago' : `${y} years ago`;
}

const KIND_LABEL: Record<Launcher['kind'], string> = {
  steam: 'Steam game',
  shortcut: 'Non-Steam shortcut',
  custom: 'Custom launcher',
};

export function GameSheet({
  launcher,
  coverSource,
  busy,
  onPlay,
  onClose,
}: {
  launcher: Launcher | null;
  coverSource?: ImageSourcePropType;
  busy?: boolean;
  onPlay: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const marks = useLibraryMarks();
  if (!launcher) return null;

  const key = bookmarkKey(launcher);
  const marked = marks.isBookmarked(key);

  const nowSec = Math.floor(Date.now() / 1000);
  const played = playtimeLabel(launcher.playtime_min);
  // Only claim a playtime when the box actually sent one. An older agent sends
  // nothing, and "never played" would then be a statement about our data rather
  // than about the user's library.
  const knowsPlaytime = launcher.playtime_min != null || launcher.last_played != null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {/* Tapping outside cancels — the safe outcome for a sheet whose other
          button starts a game on the television. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.head}>
            {coverSource ? (
              <Image source={coverSource} style={styles.art} resizeMode="cover" />
            ) : (
              <View style={[styles.art, styles.artFallback]}>
                <Ionicons name="rocket-outline" size={20} color={t.textDim} />
              </View>
            )}
            <View style={styles.headBody}>
              <Text style={styles.title} numberOfLines={3}>
                {launcher.label}
              </Text>
              {knowsPlaytime ? (
                <Text style={styles.sub}>
                  {played}
                  {launcher.last_played != null
                    ? ` · ${lastPlayedLabel(launcher.last_played, nowSec)}`
                    : ''}
                </Text>
              ) : null}
            </View>
          </View>

          <ScrollView style={styles.detail} contentContainerStyle={styles.detailBody}>
              <Row label="Type" value={KIND_LABEL[launcher.kind]} />
              {launcher.appid != null ? <Row label="Steam appid" value={String(launcher.appid)} /> : null}
              {knowsPlaytime ? (
                <>
                  <Row label="Time played" value={played} />
                  <Row label="Last opened" value={lastPlayedLabel(launcher.last_played, nowSec)} />
                </>
              ) : (
                // Say WHY it is missing rather than showing a blank or a zero.
                <Text style={styles.note}>
                  Playtime needs the Couchside service 2.9.71 or newer on the box.
                </Text>
              )}
            {/* Bookmark lives with the game's facts, not in the action row:
                it is a note-to-self about this game, not a decision about what
                happens on the TV right now. */}
            <Pressable
              onPress={() => {
                if (!key) return;
                hapticLight();
                toggleBookmarked(key);
              }}
              disabled={!key}
              accessibilityRole="button"
              accessibilityState={{ selected: marked }}
              accessibilityLabel={marked ? 'Remove bookmark' : 'Bookmark this game'}
              style={({ pressed }) => [styles.bookmark, pressed && styles.pressed]}>
              <Ionicons
                name={marked ? 'bookmark' : 'bookmark-outline'}
                size={15}
                color={marked ? t.green : t.textDim}
              />
              <Text style={[styles.bookmarkText, marked && styles.bookmarkTextOn]}>
                {marked ? 'BOOKMARKED' : 'BOOKMARK'}
              </Text>
            </Pressable>
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]}>
              <Text style={styles.btnGhostText}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                hapticLight();
                onPlay();
              }}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Play ${launcher.label}`}
              style={({ pressed }) => [styles.btn, styles.btnPlay, pressed && styles.pressed]}>
              <Ionicons name="play" size={15} color="#04140c" />
              <Text style={styles.btnPlayText}>{busy ? 'LAUNCHING…' : 'PLAY'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: '#000b',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 22,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: t.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: t.cardBorder,
      padding: 14,
      gap: 12,
    },
    head: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    art: { width: 58, height: 87, borderRadius: 8, backgroundColor: t.inset },
    artFallback: { alignItems: 'center', justifyContent: 'center' },
    headBody: { flex: 1, gap: 3 },
    title: { color: t.text, fontSize: 16, fontWeight: '800' },
    sub: { color: t.textDim, fontSize: 12, fontFamily: mono },
    detail: { maxHeight: 190 },
    detailBody: { gap: 8, paddingTop: 2 },
    row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
    rowLabel: { color: t.textDim, fontSize: 12, fontFamily: mono },
    rowValue: { color: t.text, fontSize: 12, fontFamily: mono, flexShrink: 1, textAlign: 'right' },
    bookmark: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 14,
      paddingVertical: 11,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: t.cardBorder,
      backgroundColor: t.inset,
    },
    bookmarkText: { color: t.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
    bookmarkTextOn: { color: t.green },
    note: { color: t.textFaint, fontSize: 12, lineHeight: 17 },
    actions: { flexDirection: 'row', gap: 10 },
    btn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 11,
      paddingVertical: 12,
    },
    btnGhost: { backgroundColor: t.inset, borderWidth: 1, borderColor: t.cardBorder },
    btnGhostText: { color: t.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
    btnPlay: { backgroundColor: t.green },
    btnPlayText: { color: '#04140c', fontSize: 13, fontWeight: '900', letterSpacing: 1, fontFamily: mono },
    pressed: { opacity: 0.65 },
  });
