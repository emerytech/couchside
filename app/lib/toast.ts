/**
 * One transient message, from anywhere, shown above every tab.
 *
 * The Launch tab already had a local toast, but the thing most worth announcing
 * — "your download finished" — is precisely what you want to hear while you are
 * NOT on that tab. A toast that only exists inside one screen cannot say it.
 *
 * Same module-level external-store shape as lib/prefs.ts. Deliberately holds
 * ONE message: these are interruptions, and a queue of them stacking up is how
 * an app starts talking over itself.
 *
 * NOT an OS notification. Nothing here reaches the user when the app is closed
 * or backgrounded — see hooks/useDownloadWatch.ts for why that is a different,
 * larger decision.
 */
import { useSyncExternalStore } from 'react';

/** How long a message stays up. Long enough to read a game title, short enough
 *  not to sit over the thing you are trying to tap. */
export const TOAST_MS = 3200;

let message: string | null = null;
let seq = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const getSnapshot = () => message;

/** Say something. A newer message REPLACES an older one rather than queueing —
 *  the most recent thing that happened is the one worth reading. */
export function showToast(msg: string): void {
  message = msg;
  const mine = ++seq;
  emit();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    // Only clear if nothing newer arrived, or a later message would be cut short
    // by an earlier message's timer.
    if (mine === seq) {
      message = null;
      emit();
    }
  }, TOAST_MS);
}

export function useToast(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
