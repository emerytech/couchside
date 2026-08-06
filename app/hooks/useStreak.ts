/**
 * The streak, persisted on the phone.
 *
 * Splits cleanly from lib/streak.ts: all the arithmetic lives there and is
 * tested in bare Node; this file is only storage + when-to-run, which is the
 * part that cannot be unit tested without a device.
 *
 * WHEN IT COUNTS A DAY: on the first render after the app has a REACHABLE box
 * (or a paired TV in remote-only mode). Deliberately not "on launch" — an app
 * opened to find the box dead should not be congratulated for it, and counting
 * a failed launch as usage would make the number a lie.
 *
 * ON-DEVICE ONLY. No account, no server, no analytics — the same promise as the
 * rest of the app. AsyncStorage-equivalent via the existing prefs storage.
 */
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { advance, EMPTY_STREAK, pendingMilestone, type StreakState } from '@/lib/streak';

const KEY = 'couchside.streak.v1';

// Same web-vs-native split every other persisted value in this app uses
// (lib/haptics.ts, lib/prefs.ts): SecureStore on device, localStorage in the
// dev harness, and a failure is never fatal — a streak is not worth a crash.
async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // storage unavailable (private mode): the streak lives in memory today
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function loadStreak(): Promise<StreakState> {
  try {
    const raw = await storageGet(KEY);
    if (!raw) return EMPTY_STREAK;
    const o = JSON.parse(raw) as Partial<StreakState>;
    // Coerce every field: a hand-edited or half-written value must not put NaN
    // into the arithmetic and render "NaN days".
    return {
      days: Number.isFinite(o.days) ? Math.max(0, Math.floor(o.days as number)) : 0,
      lastDay: typeof o.lastDay === 'string' ? o.lastDay : '',
      celebrated: Number.isFinite(o.celebrated) ? Math.max(0, Math.floor(o.celebrated as number)) : 0,
      best: Number.isFinite(o.best) ? Math.max(0, Math.floor(o.best as number)) : 0,
    };
  } catch {
    return EMPTY_STREAK;
  }
}

function saveStreak(s: StreakState): void {
  void storageSet(KEY, JSON.stringify(s));
}

export type StreakView = {
  state: StreakState;
  /** Milestone to celebrate now, or null. Cleared by ack(). */
  milestone: number | null;
  /** Mark the current milestone as celebrated so it never fires again. */
  ack: () => void;
  ready: boolean;
};

export function useStreak(active: boolean, enabled: boolean): StreakView {
  const [state, setState] = useState<StreakState>(EMPTY_STREAK);
  const [ready, setReady] = useState(false);
  const [counted, setCounted] = useState(false);

  // Load once.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const stored = await loadStreak();
      if (!alive) return;
      setState(stored);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Count today ONCE per app session, and only once the box actually answered.
  useEffect(() => {
    if (!ready || !active || counted) return;
    setCounted(true);
    setState((prev) => {
      const next = advance(prev, new Date());
      if (next !== prev) saveStreak(next);
      return next;
    });
  }, [ready, active, counted]);

  const ack = useCallback(() => {
    setState((prev) => {
      const m = pendingMilestone(prev);
      if (m == null) return prev;
      const next = { ...prev, celebrated: m };
      saveStreak(next);
      return next;
    });
  }, []);

  return {
    state,
    // Opting out silences the celebration without stopping the count, so
    // turning it back on does not restart from zero.
    milestone: enabled ? pendingMilestone(state) : null,
    ack,
    ready,
  };
}
