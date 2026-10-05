import { useCallback, useEffect, useRef } from 'react';

import { usePoll, type PollState } from '@/hooks/usePoll';
import { api, capsEqual, hostKey, Status } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { isValidLanIp, normalizeMac } from '@/lib/settings';
import type { Settings } from '@/lib/settings';

/**
 * Keep the ACTIVE box's persisted caps in sync with what its service actually
 * reports, from a hook that is always mounted (the tab layout) — not only
 * where RemotePowerBar happens to render (Console/Setup).
 *
 * Why this exists: since caps persistence learned couchmode/desktop, a stale
 * `false` cached before a box BECAME capable sticks until something re-learns
 * caps. The only learner used to be RemotePowerBar, so a user who lived on the
 * Pad tab kept a hidden Couch button indefinitely while the box itself
 * advertised couchmode:true (observed in the field on Android 2.9.5 after the
 * box's 2.9.15 service made undocked handhelds couch-capable).
 *
 * Slow cadence on purpose — this is a safety net, not the primary status poll.
 * Same guards as the RemotePowerBar learner: value-equality (caps is a fresh
 * object every poll) so storage is written once per real change, and hostKey
 * as resetKey so a stale instance can never attribute one box's caps to
 * another (that exact mis-attribution once ping-ponged writes forever).
 *
 * RETURNS ITS POLL. This is the only status poll that is mounted on every tab,
 * so the tabs layout reads it as the feature tour's "is the box answering"
 * signal (lib/tour.ts tourLink) rather than starting a second pinger.
 */
const CAPS_SYNC_MS = 30_000;

export function useCapsSync(): PollState<Status> {
  const { settings, ready, update } = useSettings();
  const configured = settings.host.trim().length > 0;
  const poll = useCallback(() => api.status(settings), [settings]);
  const status = usePoll<Status>(
    poll, CAPS_SYNC_MS, ready && configured, hostKey(settings));
  // Consume each response once. Settings updates (including the switcher's
  // ping-based IP learner) must never reapply this poll's older snapshot.
  const consumed = useRef<Status | null>(null);
  useEffect(() => {
    const data = status.data;
    if (!data || status.dataKey !== hostKey(settings) || consumed.current === data) return;
    consumed.current = data;
    const patch: Partial<Settings> = {};
    if (data.caps && !capsEqual(data.caps, settings.caps)) patch.caps = data.caps;
    // Persist only a non-empty STRING, so this layer and normalizeBox agree on
    // what a version is: a value one accepts but the other drops would be
    // re-learned and re-dropped every launch (the per-launch write this guards).
    if (typeof data.agent_version === 'string' && data.agent_version && data.agent_version !== settings.version) {
      patch.version = data.agent_version;
    }
    const mac = normalizeMac(data.net?.mac);
    if (mac && mac !== settings.mac) patch.mac = mac;
    if (data.ip && isValidLanIp(data.ip) && data.ip !== settings.lastIp) patch.lastIp = data.ip;
    if (Object.keys(patch).length) void update(patch);
  }, [status.data, status.dataKey, settings, update]);
  return status;
}
