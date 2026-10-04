/** A missed poll is uncertainty, not proof that a device went offline. */
export function fleetHealth(entry: {
  error: string | null;
  failures: number;
  lastSuccess: number | null;
} | undefined, now: number): 'checking' | 'online' | 'reconnecting' | 'offline' {
  if (!entry) return 'checking';
  if (!entry.error) return 'online';
  if (entry.failures < 3 && (entry.lastSuccess == null || now - entry.lastSuccess < 15000)) {
    return 'reconnecting';
  }
  return 'offline';
}
