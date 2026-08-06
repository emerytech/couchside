/**
 * Where the price is in its planned rise — computed, never hardcoded prose.
 *
 * THE OWNER'S ACTUAL PLAN, which is the only reason this copy is allowed to
 * exist: $4.99 today, $9.99 from 1 September 2026, and $19.99 as the final
 * price once 1,000 purchases are reached.
 *
 * WHY THIS IS A FUNCTION OF `now` AND NOT A STRING. "Going up on September 1"
 * is true today and FALSE on September 2. A frozen line in a component would
 * quietly become a false scarcity claim the moment the date passed — the kind
 * of thing App Review rejects as misleading marketing, and this app has already
 * eaten one IAP rejection. After the date, the urgency line disappears on its
 * own rather than needing anyone to remember it.
 *
 * NO COUNTDOWN TIMER, deliberately. A ticking clock that resets is a dark
 * pattern; a fixed date is a fact. Days-remaining is derived from the real date,
 * so it can only be wrong if the price change itself does not happen.
 *
 * THE 1,000-PURCHASE STEP CARRIES NO DATE, because nobody knows one. It is
 * stated as a plan ("then $19.99"), never as a deadline.
 *
 * ZERO imports so it is testable in bare Node — the whole point is that the
 * claim changes correctly as time passes, which can only be checked by feeding
 * it dates.
 */

/** The day the price becomes $9.99. Local date, matching how a user reads it. */
export const PHASE_2_DATE = new Date(2026, 8, 1); // 1 September 2026
export const PHASE_2_PRICE = '$9.99';
export const FINAL_PRICE = '$19.99';
/** Purchases after which the final price applies. Plan, not a deadline. */
export const FINAL_PRICE_AT_PURCHASES = 1000;

export type PricingPhase = {
  /** 'early' before the rise, 'phase2' after it. */
  phase: 'early' | 'phase2';
  /** Headline for the offer, or null when there is nothing time-bound to say. */
  urgency: string | null;
  /** The price this will become next, for a struck-through comparison. */
  nextPrice: string | null;
  /** Whole days until the rise; null once it has passed. */
  daysUntil: number | null;
  /** The always-true line about where pricing ends up. */
  plan: string;
};

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function pricingPhase(now: Date): PricingPhase {
  const days = Math.round((startOfDay(PHASE_2_DATE) - startOfDay(now)) / 86400000);
  if (days > 0) {
    return {
      phase: 'early',
      urgency:
        days === 1
          ? `Early-adopter price — goes to ${PHASE_2_PRICE} tomorrow`
          : `Early-adopter price — goes to ${PHASE_2_PRICE} in ${days} days`,
      nextPrice: PHASE_2_PRICE,
      daysUntil: days,
      plan: `One-time purchase. Price rises to ${PHASE_2_PRICE} on 1 September, then ${FINAL_PRICE} after ${FINAL_PRICE_AT_PURCHASES.toLocaleString()} purchases.`,
    };
  }
  // The date has passed. No invented urgency: the remaining step depends on a
  // purchase count nobody can see from inside the app, so it is stated as a
  // plan with no deadline attached.
  return {
    phase: 'phase2',
    urgency: null,
    nextPrice: FINAL_PRICE,
    daysUntil: null,
    plan: `One-time purchase. Price rises to ${FINAL_PRICE} after ${FINAL_PRICE_AT_PURCHASES.toLocaleString()} purchases.`,
  };
}
