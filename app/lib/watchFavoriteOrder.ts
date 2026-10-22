export function normalizeFavorites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string =>
    typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id)))].slice(0, 32);
}

/** Stable favorite-first ordering; never invents services the box omitted. */
export function orderFavoriteServices(services: string[], favorites: string[]): string[] {
  const pinned = new Set(favorites);
  return [...services.filter(id => pinned.has(id)), ...services.filter(id => !pinned.has(id))];
}

