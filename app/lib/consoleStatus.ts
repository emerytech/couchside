import type { Status } from './api.ts';

/** Validate the core values Console dereferences. CPU/OS metadata is optional
 * in the protocol (including on Windows and older Linux agents). */
export function usableConsoleStatus(raw: Status | null | undefined): Status | null {
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!raw || !raw.mem || !Array.isArray(raw.load) || !finite(raw.load[0]) ||
      !finite(raw.mem.total_mb) || raw.mem.total_mb <= 0 || !finite(raw.mem.used_mb) ||
      raw.mem.used_mb < 0 || !Array.isArray(raw.disks) ||
      !raw.disks.every(d => d && typeof d.mount === 'string' && finite(d.used_gb) &&
        finite(d.total_gb) && finite(d.pct))) return null;
  return raw;
}
