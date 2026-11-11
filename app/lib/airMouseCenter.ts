/** One absolute move, never a click or a replay. Recheck ownership after probing. */
export async function centerAirMousePointer(
  probe: () => Promise<{ session?: string | null } | null>,
  move: (x: number, y: number) => void,
  current: () => boolean,
): Promise<void> {
  if (!current()) return;
  const info = await probe();
  if (!current()) return;
  if (info?.session !== 'gamescope') throw new Error('Cursor centering is not supported on this target.');
  move(0.5, 0.5);
}
