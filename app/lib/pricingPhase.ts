/**
 * Where the price is on its planned ladder — computed, never hardcoded prose.
 *
 * THE OWNER'S ACTUAL PLAN, which is the only reason urgency copy is allowed to
 * exist here at all:
 *
 *   now          $4.99   early adopter
 *   1 Sep 2026   $7.99
 *   1 Oct 2026   $9.99
 *   1 Nov 2026  $14.99   held indefinitely
 *
 * These MUST match couchside.tv. An in-app price claim that disagrees with the
 * public site is worse than having no claim: it is two different promises about
 * the same product. (An earlier draft of this file said $9.99 on 1 September and
 * $19.99 later; the site was right and the code was wrong.)
 *
 * WHY THIS IS A FUNCTION OF `now` AND NOT A STRING. "Goes up on September 1" is
 * true today and FALSE on September 2. A frozen line in a component quietly
 * becomes a false scarcity claim the moment a date passes — the kind of thing
 * App Review rejects as misleading marketing, and this app has already taken one
 * IAP rejection. Each step retires itself.
 *
 * NO COUNTDOWN TIMER, deliberately. A clock that resets is a dark pattern; a
 * fixed date is a fact. Days-remaining is derived from the real date, so it can
 * only be wrong if the price change itself does not happen.
 *
 * AFTER THE LAST STEP THERE IS NO URGENCY AT ALL. $14.99 is held indefinitely,
 * so the copy stops selling a deadline rather than inventing one.
 *
 * ZERO imports so it is testable in bare Node — the whole point is that the
 * claim changes correctly as time passes, which can only be checked by feeding
 * it dates.
 */

export type PriceStep = {
  /** Local date the step takes effect. */
  from: Date;
  /** Price from that date, as the owner states it publicly (USD). */
  price: string;
};

/** The rises, in order. Anything before the first is the early-adopter price. */
export const LADDER: PriceStep[] = [
  { from: new Date(2026, 8, 1), price: '$7.99' }, // 1 September 2026
  { from: new Date(2026, 9, 1), price: '$9.99' }, // 1 October 2026
  { from: new Date(2026, 10, 1), price: '$14.99' }, // 1 November 2026
];

/** What it costs before the ladder starts. */
export const EARLY_PRICE = '$4.99';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type PricingPhase = {
  /** The price this is at right now, per the plan. */
  currentPrice: string;
  /** The price it becomes next, or null once the ladder is finished. */
  nextPrice: string | null;
  /** Whole days until the next rise; null once finished. */
  daysUntil: number | null;
  /** Time-bound headline, or null when there is nothing honest to hurry about. */
  urgency: string | null;
  /** The always-true line about where pricing is heading. */
  plan: string;
};

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayName(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function pricingPhase(now: Date): PricingPhase {
  const today = startOfDay(now);
  const next = LADDER.find((s) => startOfDay(s.from) > today) ?? null;

  // Current price = the last step already in effect, else the early price.
  const passed = LADDER.filter((s) => startOfDay(s.from) <= today);
  const currentPrice = passed.length ? passed[passed.length - 1].price : EARLY_PRICE;

  if (!next) {
    // Ladder finished. $14.99 is held indefinitely — say nothing time-bound.
    return {
      currentPrice,
      nextPrice: null,
      daysUntil: null,
      urgency: null,
      plan: 'One-time purchase. No subscription, ever.',
    };
  }

  const days = Math.round((startOfDay(next.from) - today) / 86400000);
  const isEarly = passed.length === 0;
  return {
    currentPrice,
    nextPrice: next.price,
    daysUntil: days,
    urgency:
      days === 1
        ? `${isEarly ? 'Early-adopter price' : 'Current price'} — goes to ${next.price} tomorrow`
        : `${isEarly ? 'Early-adopter price' : 'Current price'} — goes to ${next.price} in ${days} days`,
    plan: `One-time purchase, no subscription. Rises to ${next.price} on ${dayName(next.from)}.`,
  };
}
