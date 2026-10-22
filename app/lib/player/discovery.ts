/** Provider-neutral metadata. Playback is resolved separately by the box. */
export type MediaRef = { provider: string; id: string };
export type MediaTitle = {
  ref: MediaRef;
  kind: 'movie' | 'series' | 'episode';
  name: string;
  description: string;
  year?: number;
  poster?: string;
  attribution: string;
  license?: string;
  /** Explicit IDs only: never merge unrelated titles by a similar name. */
  externalIds?: Record<string, string>;
};
export type MediaEpisode = MediaTitle & { season: number; episode: number };
export type DiscoveryPage = { titles: MediaTitle[]; next?: string };
export interface MetadataProvider {
  readonly id: string;
  readonly name: string;
  readonly attribution: string;
  discover(signal: AbortSignal, cursor?: string): Promise<DiscoveryPage>;
  search(query: string, signal: AbortSignal, cursor?: string): Promise<DiscoveryPage>;
  details(id: string, signal: AbortSignal): Promise<MediaTitle | null>;
  episodes?(id: string, season: number, signal: AbortSignal): Promise<MediaEpisode[]>;
}

export function mediaKey(ref: MediaRef): string {
  return JSON.stringify([ref.provider, ref.id]);
}

/** Adapters are compiled-in code, not user-supplied URLs or executable add-ons.
 * API credentials belong in a future agent-side adapter, never title records. */
export class MetadataProviders {
  private readonly providers = new Map<string, MetadataProvider>();
  add(provider: MetadataProvider): void {
    if (this.providers.has(provider.id)) throw new Error('Duplicate metadata provider');
    this.providers.set(provider.id, provider);
  }
  get(id: string): MetadataProvider | undefined { return this.providers.get(id); }
  list(): MetadataProvider[] { return [...this.providers.values()]; }
}

type BoxCatalog = { metas: { id: string; name: string; description: string; credit: string; license: string }[] };
/** The first adapter uses the existing licensed sample catalog. No network API,
 * API key, new media URL, or promise of subscription availability is involved. */
export function boxCatalogProvider(catalog?: BoxCatalog): MetadataProvider {
  const titles: MediaTitle[] = (catalog?.metas ?? []).map(video => ({
    ref: { provider: 'couchside-samples', id: video.id }, kind: 'movie',
    name: video.name, description: video.description,
    attribution: video.credit, license: video.license,
  }));
  const check = (signal: AbortSignal) => { if (signal.aborted) throw new Error('Request cancelled'); };
  return {
    id: 'couchside-samples', name: 'Sample films', attribution: 'Credits shown with each film',
    async discover(signal) { check(signal); return { titles }; },
    async search(query, signal) {
      check(signal);
      const q = query.trim().toLocaleLowerCase();
      return { titles: titles.filter(t => `${t.name} ${t.description}`.toLocaleLowerCase().includes(q)) };
    },
    async details(id, signal) { check(signal); return titles.find(t => t.ref.id === id) ?? null; },
  };
}
