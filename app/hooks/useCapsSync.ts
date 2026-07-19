import { useCallback, useEffect } from 'react';

import { usePoll } from '@/hooks/usePoll';
import { api, capsEqual, hostKey, Status } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';

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
 */
const CAPS_SYNC_MS = 30_000;

export function useCapsSync(): void {
  const { settings, ready, update } = useSettings();
  const configured = settings.host.trim().length > 0;
  const poll = useCallback(() => api.status(settings), [settings]);
  const status = usePoll<Status>(
    poll, CAPS_SYNC_MS, ready && configured, hostKey(settings));
  const caps = status.data?.caps;
  useEffect(() => {
    if (caps && !capsEqual(caps, settings.caps)) {
      void update({ caps });
    }
  }, [caps, settings.caps, update]);
}
