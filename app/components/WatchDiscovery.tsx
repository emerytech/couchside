import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import { mediaKey, type MediaTitle, type MetadataProvider } from '@/lib/player/discovery';
import { playerLibrary, usePlayerLibrary } from '@/lib/player/libraryStore';

type Props = {
  provider: MetadataProvider;
  mode: 'discover' | 'library';
  playableIds: ReadonlySet<string>;
  busy: boolean;
  onPlay: (title: MediaTitle) => void;
};

/** Metadata never supplies a playback URL. onPlay resolves a current box ID. */
export function WatchDiscovery({ provider, mode, playableIds, busy, onPlay }: Props) {
  const t = useTheme();
  const s = useThemedStyles(styles);
  const library = usePlayerLibrary();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'saved' | 'progress' | 'watched'>('saved');
  const [titles, setTitles] = useState<MediaTitle[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    // Searching personal history is local, never a metadata-provider query.
    if (mode !== 'discover') return;
    const controller = new AbortController();
    setStatus('loading');
    const timer = setTimeout(() => {
      const request = query.trim() ? provider.search(query.trim(), controller.signal) : provider.discover(controller.signal);
      void request.then(page => {
        if (!controller.signal.aborted) { setTitles(page.titles); setStatus('ready'); }
      }).catch(() => { if (!controller.signal.aborted) { setTitles([]); setStatus('error'); } });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [provider, query, mode]);

  const entries = library.entries;
  const visible = useMemo(() => {
    if (mode === 'discover') return status === 'ready' ? titles : [];
    const q = query.trim().toLocaleLowerCase();
    return entries.filter(e => filter === 'saved' ? e.saved : filter === 'watched' ? e.watched
      : !!e.progress && !e.watched).map(e => e.title)
      .filter(title => `${title.name} ${title.description}`.toLocaleLowerCase().includes(q));
  }, [mode, status, titles, entries, filter, query]);
  // Derive selection from visible results; a hidden previous title can never
  // retain an active Play action after a search or filter change.
  const detail = visible.find(title => mediaKey(title.ref) === selected);
  const entry = detail && entries.find(e => mediaKey(e.title.ref) === mediaKey(detail.ref));
  const canPlay = !!detail && detail.ref.provider === 'couchside-samples' && playableIds.has(detail.ref.id);

  const button = (name: string, action: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={action} disabled={disabled}
      style={({ pressed }) => [s.button, disabled && { opacity: 0.45 }, pressed && { opacity: 0.7 }]}>
      <Text style={s.buttonText}>{name}</Text>
    </Pressable>
  );
  return <View style={s.root} testID={`watch-${mode}`}>
    <View style={s.hero}>
      <Text style={s.eyebrow}>COUCHSIDE PLAYER · PREVIEW</Text>
      <Text style={s.heading}>{mode === 'discover' ? 'Find your next watch.' : 'Your next night in.'}</Text>
      <Text style={s.body}>{mode === 'discover'
        ? 'Browse titles, save something for later, and play on your box.'
        : 'Your saved titles and viewing progress stay on this device.'}</Text>
    </View>
    <TextInput accessibilityLabel="Search titles" placeholder={mode === 'discover' ? 'Search titles' : 'Search your library'}
      placeholderTextColor={t.textFaint} value={query} onChangeText={value => { setQuery(value); setSelected(null); }}
      maxLength={100} autoCorrect={false} returnKeyType="search" style={s.search} testID="watch-discovery-search" />
    {mode === 'library' ? <View style={s.row}>
      {(['saved', 'progress', 'watched'] as const).map(tab => <Pressable key={tab}
        accessibilityRole="button" accessibilityState={{ selected: filter === tab }}
        onPress={() => { setFilter(tab); setSelected(null); }} style={[s.chip, filter === tab && s.chipActive]}>
        <Text style={s.body}>{tab === 'saved' ? 'My list' : tab === 'progress' ? 'In progress' : 'Watched'}</Text>
      </Pressable>)}
    </View> : <View style={s.notice}>
      <Text style={s.title}>{provider.name}</Text>
      <Text style={s.muted}>Licensed sample catalog while we arrange a movie and TV metadata provider. More providers can be added without replacing your library.</Text>
    </View>}
    {library.error ? <Text accessibilityRole="alert" style={{ color: t.red }}>{library.error}</Text> : null}
    {detail ? <View style={s.detail} testID="watch-title-details">
      <Text style={s.heading}>{detail.name}</Text>
      <Text style={s.eyebrow}>{detail.kind.toUpperCase()}{detail.year ? ` · ${detail.year}` : ''}</Text>
      <Text style={s.body}>{detail.description || 'No description available.'}</Text>
      {entry?.progress ? <Text style={s.muted}>
        {Math.floor(entry.progress.position / 60)} of {Math.ceil(entry.progress.duration / 60)} min watched
      </Text> : null}
      <View style={s.row}>
        {button(entry?.saved ? 'Remove from My list' : 'Save to My list', () => { void playerLibrary.update(detail, { saved: !entry?.saved }); }, !library.ready)}
        {button(entry?.watched ? 'Mark unwatched' : 'Mark watched', () => { void playerLibrary.update(detail, { watched: !entry?.watched }); }, !library.ready)}
      </View>
      {canPlay ? button(entry?.progress ? 'Play from beginning on TV' : 'Play on TV', () => onPlay(detail), busy)
        : <Text style={s.muted}>Saved in your library. This box doesn’t currently offer a playback source for this title.</Text>}
      <Text style={s.muted}>{detail.attribution}</Text>
      {detail.license ? <Text selectable style={s.muted}>{detail.license}</Text> : null}
      {entry ? button('Forget title and history', () => { void playerLibrary.remove(detail.ref); setSelected(null); }, !library.ready) : null}
    </View> : null}
    {mode === 'discover' && status === 'loading' ? <Text style={s.body}>Finding titles…</Text>
      : mode === 'discover' && status === 'error' ? <Text accessibilityRole="alert" style={s.body}>Couldn’t load titles. Change your search to retry.</Text>
      : !library.ready && mode === 'library' ? <Text style={s.body}>Opening your library…</Text>
      : visible.length === 0 ? <View style={s.notice} testID="watch-discovery-empty">
        <Text style={s.title}>{query.trim() ? 'No matching titles' : mode === 'discover' ? 'No titles available yet' : 'Make room for a good watch.'}</Text>
        <Text style={s.muted}>{query.trim() ? 'Try another title or clear your search.' : mode === 'library'
          ? 'Save a title in Discover, or watch a supported film to start building your library.' : 'Your box may need a newer Player catalog.'}</Text>
      </View> : <View style={s.grid}>
        {visible.map(title => {
          const record = entries.find(e => mediaKey(e.title.ref) === mediaKey(title.ref));
          return <Pressable key={mediaKey(title.ref)} onPress={() => setSelected(mediaKey(title.ref))}
            accessibilityRole="button" accessibilityLabel={`Details for ${title.name}`}
            accessibilityState={{ selected: selected === mediaKey(title.ref) }} style={s.card}>
            {title.poster ? <Image source={{ uri: title.poster }} accessibilityLabel={`${title.name} artwork`} style={s.poster} />
              : <View style={s.poster}><Text style={s.posterMark}>▶</Text><Text style={s.posterTitle}>{title.name}</Text><Text style={s.muted}>COUCHSIDE CINEMA</Text></View>}
            <View style={s.caption}><Text style={s.title}>{title.name}</Text>
              <Text style={s.muted}>{record?.watched ? '✓ Watched' : record?.saved ? '✓ In My list' : 'View details'}</Text>
              {record?.progress ? <View style={s.track}><View style={[s.progress, { width: `${Math.min(100, record.progress.position / record.progress.duration * 100)}%` }]} /></View> : null}
            </View>
          </Pressable>;
        })}
      </View>}
    {mode === 'library' ? <Text style={s.muted}>Progress is recorded only for identified Couchside playback. Automatic resume and subscription-service history are not connected yet. Up to 200 titles are kept on this device.</Text> : null}
  </View>;
}

const styles = (t: Palette) => StyleSheet.create({
  root: { gap: 16 }, hero: { paddingVertical: 20, gap: 10 },
  eyebrow: { color: t.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  heading: { color: t.text, fontSize: 27, fontWeight: '800' },
  title: { color: t.text, fontSize: 16, fontWeight: '700' },
  body: { color: t.text, fontSize: 15, lineHeight: 23 },
  muted: { color: t.textDim, fontSize: 13, lineHeight: 20 },
  search: { color: t.text, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.inset, borderRadius: 16, padding: 15, fontSize: 16 },
  notice: { backgroundColor: t.card, borderRadius: 16, padding: 16, gap: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { padding: 12, borderRadius: 24, borderWidth: 1, borderColor: t.cardBorder },
  chipActive: { borderColor: t.accent, backgroundColor: t.card },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  card: { width: '47%', minWidth: 140, maxWidth: 260, backgroundColor: t.card, borderRadius: 18, overflow: 'hidden' },
  poster: { width: '100%', aspectRatio: 2 / 3, backgroundColor: t.inset, padding: 18, justifyContent: 'space-between' },
  posterMark: { color: t.accent, fontSize: 32 },
  posterTitle: { color: t.text, fontSize: 25, fontWeight: '800' },
  caption: { padding: 12, gap: 6 }, detail: { borderWidth: 1, borderColor: t.accent, padding: 18, borderRadius: 18, gap: 12, backgroundColor: t.card },
  button: { padding: 14, minHeight: 48, borderRadius: 12, backgroundColor: t.inset },
  buttonText: { color: t.accent, fontSize: 14, fontWeight: '700' },
  track: { height: 4, backgroundColor: t.inset, borderRadius: 2, overflow: 'hidden' },
  progress: { height: 4, backgroundColor: t.accent },
});
