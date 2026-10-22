# Player discovery and personal library (local preview)

The Watch screen has Remote, Discover, and My Library views. Remote retains the
existing service controls. Discovery currently uses the licensed sample catalog
already advertised by the box. No TMDB integration, key, account, paid plan, or
third-party catalog has been enabled.

## Adding a metadata provider

`app/lib/player/discovery.ts` defines `MetadataProvider`, `MediaTitle`, paginated
results, cancellation, detail lookup, and an optional season/episode lookup.
Implement the interface in a separate adapter and pass it to `WatchDiscovery`.
`MetadataProviders` holds compiled-in adapters; it rejects duplicate provider IDs.
The first adapter is `boxCatalogProvider`. A future provider picker can use the
same registry; the current UI has just one provider.

IDs are `(provider, id)` pairs. Optional explicit external IDs can support a
future deliberate migration/linking step; similar names do not cause automatic
merges. Saved title snapshots and credits stay readable when the source is
unavailable. Replacing a provider does not discard another provider's entries.
Each adapter must normalize/validate responses, retain attribution and allowed
artwork URLs, and implement its own rate limits, caching, errors, and API terms.
API secrets should live in an agent-side adapter rather than an app bundle or
library record. Search cancels obsolete requests; hidden selections cannot play.

Metadata is not playback authorization or verified regional service availability.
Only the current box's known sample IDs can reach the existing catalog-open API.
Providers cannot insert stream URLs, scripts, or launch commands into that path.
Movies, series, and episodes have shared data types; season/episode browsing UI
and a real movie/TV provider remain follow-up work.

## Personal library

`library.ts` holds a versioned, bounded collection (200 titles), saved/watched
flags, title snapshots, explicit IDs, and identified playback progress. Mutations
wait for hydration and write in order. Unreadable/future data is not overwritten;
save failures are visible. An at-capacity library preserves its existing titles.

`libraryStore.ts` persists JSON in the native app's document sandbox (with a
recovery copy), or localStorage in the browser preview. It uses existing Expo
FileSystem, with no new dependencies. This is device-local viewing history, not
an account or cloud sync. Uninstalling the app can remove it. Both native copies
are updated when a title/history is forgotten. A corrupt native primary can be
recovered from a valid backup; a future schema is preserved during downgrade.

`PLAYER_JS_STATE` now returns an optional `catalog_id` only when the video
element's actual `currentSrc` exactly matches a fixed catalog source. The phone
records progress only with that identity and ready/error/seeking checks. Agents
without the field still work but do not generate inferred history. Source URLs
are not returned by this identity check. Netflix/Prime trailers and last-opened
configuration cannot create false catalog history.

In-progress titles show their recorded position. Opening one currently starts
from the beginning, explicitly labeled; automatic resume is not implemented.
Saved and watched actions work independently of an online box. The catalog is
sample-only and the interface labels that limitation.

## Verification

- `app/lib/__tests__/playerLibrary.test.ts`: hydration, persistence ordering,
  restart, write failure, corrupt/future schema, progress, normalization, provider
  identity and replacement contract.
- `tests/test_player_catalog_identity.cjs`: executes the agent's real generated
  state script with media stand-ins, proving exact matching and no URL output.
- Existing catalog API, transport, service surface, and TV hub checks remain
  applicable. Native storage and physical-device layout need device checks before
  including this preview in a release.
