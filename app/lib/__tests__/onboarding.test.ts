/**
 * The first-run flow's two dangerous rules.
 *
 * 1. Back inside a journey is NOT an exit. Marking onboarding done on a
 *    step-back drops someone into the app mid-setup and never offers again.
 * 2. The empty-state guards. `onboardingDone` defaults false for every install
 *    that already exists, so the pref alone would show a first-run flow to a
 *    user who has been paired for months.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  backFrom,
  FIRST_STEP,
  INSTALL_COMMAND,
  INSTALL_SUCCESS_MARKER,
  isExit,
  shouldOfferWhatsNew,
  shouldShowOnboarding,
  stepForChoice,
} from '../onboarding.ts';

test('back navigates inside the flow and only leaves from the first screen', () => {
  assert.equal(backFrom('install'), 'choose');
  assert.equal(backFrom('tv'), 'choose');
  assert.equal(backFrom('choose'), 'welcome');
  assert.equal(backFrom('welcome'), null, 'only the first screen exits');
});

test('a step-back is NOT an exit, so it must not mark onboarding done', () => {
  // The bug this prevents: pressing Android back on the install screen marks the
  // flow finished and drops the user into an app they have not set up.
  assert.equal(isExit('install', 'back'), false);
  assert.equal(isExit('choose', 'back'), false);
  assert.equal(isExit('welcome', 'back'), true, 'back off the first screen leaves');
});

test('skip and finish always exit, from anywhere (control)', () => {
  for (const step of ['welcome', 'choose', 'install', 'tv'] as const) {
    assert.equal(isExit(step, 'skip'), true, `skip from ${step}`);
    assert.equal(isExit(step, 'finish'), true, `finish from ${step}`);
  }
});

test('an existing user never sees it, even with the pref unset', () => {
  // The pref defaults false for every install that already exists — this is the
  // guard that stops a months-old install being handed a welcome screen.
  assert.equal(shouldShowOnboarding({ done: false, boxCount: 1, tvCount: 0, ready: true }), false);
  assert.equal(shouldShowOnboarding({ done: false, boxCount: 0, tvCount: 1, ready: true }), false);
  assert.equal(shouldShowOnboarding({ done: false, boxCount: 2, tvCount: 3, ready: true }), false);
});

test('a genuinely fresh install sees it exactly once', () => {
  assert.equal(shouldShowOnboarding({ done: false, boxCount: 0, tvCount: 0, ready: true }), true);
  assert.equal(shouldShowOnboarding({ done: true, boxCount: 0, tvCount: 0, ready: true }), false);
});

test('nothing is decided before persisted state has loaded (control)', () => {
  // Deciding on unloaded state would flash the flow at every existing user for
  // the frame before their fleet arrives.
  assert.equal(shouldShowOnboarding({ done: false, boxCount: 0, tvCount: 0, ready: false }), false);
});

test('each choice leads to its own first task', () => {
  assert.equal(stepForChoice('box'), 'install');
  assert.equal(stepForChoice('tv'), 'tv');
});

test('the Prefs reset NAVIGATES, it does not just clear the flag', async () => {
  // Clearing onboardingDone alone cannot re-show the flow on a phone that has a
  // box: shouldShowOnboarding still returns false on the fleet guard. A reset
  // control that relies on the trigger is therefore a dead control on exactly
  // the devices whose owner would go looking for it.
  assert.equal(
    shouldShowOnboarding({ done: false, boxCount: 1, tvCount: 0, ready: true }),
    false,
    'flag cleared but a box exists — the trigger stays shut',
  );
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const setup = readFileSync(join(import.meta.dirname, '../../app/(tabs)/setup.tsx'), 'utf8');
  assert.ok(setup.includes("router.push('/onboarding')"), 'the reset must navigate directly');
});

test('the flow starts at the welcome screen', () => {
  assert.equal(FIRST_STEP, 'welcome');
});

test('the confirmation quotes what install.sh actually prints', async () => {
  // A "did you see this?" question that quotes text the box never prints teaches
  // the user to say yes to something they did not read. Checked against the real
  // installer rather than a paraphrase.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const sh = readFileSync(join(import.meta.dirname, '../../../install.sh'), 'utf8');
  assert.ok(
    sh.includes(INSTALL_SUCCESS_MARKER),
    `install.sh must actually print ${JSON.stringify(INSTALL_SUCCESS_MARKER)}`,
  );
  assert.ok(INSTALL_COMMAND.includes('couchside.tv/install.sh'), 'the command names the real script');
});

test('every screen locks orientation except the Pad, which allows landscape', async () => {
  // Rotation is allowed on exactly ONE screen. This is a source-reading guard
  // because the failure is silent: a new route outside the tab group does not
  // inherit anything, it simply rotates — which is how the first-run flow, added
  // as a sibling of (tabs), became the one screen in the app that could.
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const appDir = join(import.meta.dirname, '../../app');
  const screens: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.tsx') && !e.includes('_layout')) screens.push(p);
    }
  };
  walk(appDir);

  for (const p of screens) {
    const rel = relative(appDir, p);
    // +not-found is a dead-end error page with one line of text; it has nothing
    // to reflow and no input path.
    if (rel === '+not-found.tsx') continue;
    const src = readFileSync(p, 'utf8');
    assert.ok(src.includes('useLockOrientation('), `${rel} must state an orientation policy`);
    const mentionsLandscape =
      src.includes("'allow-landscape'") || src.includes("'landscape-locked'");
    assert.equal(
      mentionsLandscape,
      rel.endsWith('pad.tsx'),
      `only the Pad may allow landscape; ${rel} disagrees`,
    );
    if (rel.endsWith('pad.tsx')) {
      // And even there it is CONDITIONAL on the gamepad mode. A flat
      // 'allow-landscape' rotated Swipe, Mouse, Remote and the Steam menus too —
      // none of which have a landscape layout. Reported from a device.
      //
      // Asserted as a PROPERTY rather than by matching the exact expression:
      // the call site grew a third policy ('landscape-locked', for the LOCK
      // button) and an `exited` term, and a test that pins one spelling just
      // gets rewritten to whatever the code now says, which guards nothing.
      assert.ok(
        !/useLockOrientation\(\s*'(allow-landscape|landscape-locked)'\s*\)/.test(src),
        'the Pad must not allow landscape unconditionally',
      );
      assert.ok(
        /useLockOrientation\([^;]*\bmode\b[^;]*'gamepad'/.test(src),
        'the Pad landscape policy must still be conditional on the gamepad mode',
      );
    }
  }
});

test('the offer is the exact mirror of the guard that suppresses the flow', () => {
  const base = { offered: false, done: false, ready: true };
  // Existing user: has something paired, never saw onboarding. The flow is NOT
  // forced on them (guard), so it is OFFERED instead.
  assert.equal(shouldOfferWhatsNew({ ...base, boxCount: 1, tvCount: 0 }), true);
  assert.equal(shouldShowOnboarding({ done: false, boxCount: 1, tvCount: 0, ready: true }), false);
  assert.equal(shouldOfferWhatsNew({ ...base, boxCount: 0, tvCount: 2 }), true);

  // Fresh install: gets the flow itself, so there is nothing to offer.
  assert.equal(shouldOfferWhatsNew({ ...base, boxCount: 0, tvCount: 0 }), false);
  assert.equal(shouldShowOnboarding({ done: false, boxCount: 0, tvCount: 0, ready: true }), true);
});

test('asked at most once, and never after the flow has been seen', () => {
  const paired = { boxCount: 1, tvCount: 0, ready: true };
  assert.equal(shouldOfferWhatsNew({ ...paired, offered: true, done: false }), false, 'already asked');
  assert.equal(shouldOfferWhatsNew({ ...paired, offered: false, done: true }), false, 'already seen it');
});

test('declining is not the same as completing (control)', () => {
  // The reason `offered` is its own flag. If declining set `done` instead, the
  // Prefs replay control would re-offer this popup rather than replay the flow.
  const paired = { boxCount: 1, tvCount: 0, ready: true };
  const declined = { ...paired, offered: true, done: false };
  assert.equal(shouldOfferWhatsNew(declined), false, 'not asked again');
  assert.equal(
    shouldShowOnboarding({ done: declined.done, boxCount: 1, tvCount: 0, ready: true }),
    false,
    'and still not forced on them',
  );
});

test('nothing is offered before state has loaded (control)', () => {
  assert.equal(
    shouldOfferWhatsNew({ offered: false, done: false, boxCount: 1, tvCount: 0, ready: false }),
    false,
  );
});

test('the offer is actually mounted and writes its flag before navigating', async () => {
  // The wired-to-nothing guard again: a dialog gated on a condition nobody
  // renders is invisible, and a flag written AFTER navigation can be lost when
  // the navigation unmounts the component — which would re-ask on next launch.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const layout = readFileSync(join(import.meta.dirname, '../../app/(tabs)/_layout.tsx'), 'utf8');
  assert.ok(layout.includes('<WhatsNewOffer'), 'the offer must be rendered somewhere');
  assert.ok(layout.includes('shouldOfferWhatsNew('), 'and gated on the shared condition');

  const offer = readFileSync(join(import.meta.dirname, '../../components/WhatsNewOffer.tsx'), 'utf8');
  const setIdx = offer.indexOf("setPref('whatsNewOffered', true)");
  const navIdx = offer.indexOf("router.push('/onboarding')");
  assert.ok(setIdx > 0 && navIdx > 0, 'both the flag write and the navigation must exist');
  assert.ok(setIdx < navIdx, 'the flag must be written BEFORE navigating, or it can be lost');
});
