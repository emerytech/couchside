import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Tabs, useSegments } from 'expo-router';
import { currentStep, isFinalStep } from '@/lib/tour';
import { useCallback, useEffect, useRef } from 'react';

import { useCapsSync } from '@/hooks/useCapsSync';
import { hapticSelection } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { FeatureTour } from '@/components/FeatureTour';
import { TourThanks } from '@/components/TourThanks';
import { useFeatureTour } from '@/hooks/useFeatureTour';
import { showTourThanks, useTourThanks } from '@/hooks/useTourThanks';
import { useBoxes } from '@/lib/SettingsContext';
import { useTheme } from '@/lib/theme';

// NOT the landing screen. This governs back-behaviour within the tab group; on a
// cold start the index route (Console) is what renders. The comment that used to
// sit here claimed "Default screen = the swipe Remote (Pad)", which was never
// true — measured in the harness, loading "/" leaves Console active. What the app
// opens on is the `landingTab` preference, applied by the redirect below.
export const unstable_settings = {
  initialRouteName: 'pad',
};

export default function TabLayout() {
  const t = useTheme();
  const { boxes, activeBox, ready } = useBoxes();
  const landingTab = usePref('landingTab');
  // REMOTE-ONLY MODE: the app is just a smart-TV remote, no box anywhere. Every
  // box tab is hidden and the Remote tab (which talks to the TV directly, see
  // lib/tvdirect/) takes over. A pref rather than derived state, so a box owner
  // can flip to it while the box is off and flip back without the box answering.
  const remoteOnly = usePref('remoteOnlyMode');
  const segments = useSegments();
  // Always-mounted caps safety net: heals a stale persisted caps snapshot
  // (e.g. couchmode:false cached before the box became capable) no matter
  // which tab the user lives on. See hooks/useCapsSync.ts for the field bug.
  useCapsSync();

  // A "server box" (headless: no virtual gamepad, no Steam) reports these false
  // in /api/status caps, so its gaming tabs are hidden. Undefined caps (unknown,
  // or agent < 2.8.2) leaves both visible — never hide a tab on a guess.
  const caps = activeBox?.caps;
  const hidePad = caps?.gamepad === false || remoteOnly;
  // `launchers` (Windows agent >= 0.4.0-win) means "any launcher present"
  // (Steam/Epic/GOG/custom), so an Epic/GOG/Game Pass box shows the Launch tab
  // even without Steam. Older agents (and every Linux agent) don't send it, so
  // fall back to the `steam` cap — never hide the tab on a guess.
  const hideLaunch =
    remoteOnly ||
    caps?.launchers === false ||
    (caps?.launchers === undefined && caps?.steam === false);

  // The tour spotlights a tab by POSITION, so it needs the order actually
  // rendered — caps and remote-only mode change both which tabs exist and where
  // they sit. Derived from the same flags the <Tabs.Screen> entries use, so the
  // two cannot drift.
  const tabOrder = [
    'index',
    ...(remoteOnly ? ['remote'] : []),
    ...(!remoteOnly && boxes.length >= 2 ? ['fleet'] : []),
    ...(remoteOnly ? [] : ['actions']),
    ...(hidePad ? [] : ['pad']),
    ...(hideLaunch ? [] : ['launch']),
    'setup',
  ];
  const tourEnabled = usePref('featureTour');
  const tour = useFeatureTour(boxes.length > 0, tourEnabled);
  const thanksVisible = useTourThanks();

  // Thank the people who actually WALKED it. Wrapping `next` rather than
  // watching for state.done is deliberate: skipping and finishing both land on
  // TOUR_FINISHED, and someone who pressed "Skip tour" has just asked to be
  // left alone — which is the worst possible moment to show them a note about
  // buying. Only the last GOT IT gets here.
  const tourNext = useCallback(() => {
    if (isFinalStep(tour.state)) showTourThanks();
    tour.next();
  }, [tour]);

  // Take the user TO the tab being described. A spotlight on "Console" while
  // they are looking at the Pad screen explains a screen they cannot see —
  // reported from a device. Keyed on the step so it navigates once per step,
  // not on every render, and only while the tour is actually up.
  const tourStep = tour.visible ? currentStep(tour.state) : null;
  const tourTab = tourStep?.tab ?? null;
  const navigatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!tourTab) {
      navigatedFor.current = null;
      return;
    }
    // ASSERT the tab, do not just fire once at it. `segments` is in the deps so
    // this re-checks after navigation settles, because a single replace() can
    // lose a race with the router's own initial route: on ANDROID the app comes
    // up on Pad (unstable_settings.initialRouteName) and the tour's replace was
    // silently overridden. The tour then sat on Pad while its step described
    // Console — and worse, Console never mounted, so its anchors never
    // registered and the first three steps skipped themselves as "absent".
    // iOS did not show this; the comment below about index winning a cold start
    // was measured in the web harness and is not true on every platform.
    const leaf = segments[segments.length - 1];
    // Console is the index route, so its leaf segment is the GROUP name — the
    // typed-routes union has no 'index' member, which is the compiler telling
    // you the same thing.
    const onTourTab = tourTab === 'index' ? leaf === '(tabs)' : leaf === tourTab;
    if (onTourTab) {
      navigatedFor.current = tourTab;
      return;
    }
    navigatedFor.current = tourTab;
    router.replace(tourTab === 'index' ? '/(tabs)' : `/(tabs)/${tourTab}`);
  }, [tourTab, segments]);

  // On true first run (persisted fleet loaded, but empty) send the user to
  // Setup to pair. Otherwise honour the landing-tab preference.
  //
  // The redirect is how the landing tab is chosen at all: `unstable_settings.
  // initialRouteName` below does NOT decide what opens on a cold start — the
  // index route (Console) wins, which is why the app has always opened on
  // Console despite that setting naming 'pad'. Measured in the harness: loading
  // "/" leaves Console as the active tab.
  //
  // Pairing beats the preference. Someone with no box who set the landing tab to
  // Pad still needs Setup first, or they land on a remote wired to nothing.
  const redirected = useRef(false);
  useEffect(() => {
    if (!ready || redirected.current) return;
    // THE TOUR OWNS NAVIGATION WHILE IT IS UP. This effect is declared after the
    // tour's, so without this guard it ran second and overwrote the tour's first
    // step — the tour opened on Console's copy while the app sat on Pad, and the
    // user had to find Console themselves. Reported from a device.
    if (tour.visible) return;
    redirected.current = true;
    // In remote-only mode the landing tab is the Remote, always: the box tabs
    // it could otherwise name are hidden, and Console with no box is an empty
    // dashboard. Setup is still where someone with no TV yet has to go, but
    // the Remote screen says so itself rather than skipping past its own tab.
    if (remoteOnly) {
      router.replace('/(tabs)/remote');
      return;
    }
    if (boxes.length === 0) {
      router.replace('/(tabs)/setup');
      return;
    }
    // 'index' is already what renders, so redirecting to it would be a wasted
    // navigation on every cold start.
    if (landingTab !== 'index') {
      router.replace(`/(tabs)/${landingTab}`);
    }
  }, [ready, boxes.length, landingTab, remoteOnly]);

  // Bounce off a tab hidden for the active box — landing on the Pad initial
  // route for a server box, or switching from an HTPC to a server box while the
  // Pad/Launch tab is focused. Sends the user to Console (the tabs index).
  useEffect(() => {
    if (!ready) return;
    const leaf = segments[segments.length - 1];
    // Remote-only hides every box tab INCLUDING Console, so the bounce target
    // is the Remote, not the tabs index. This is also what carries a runtime
    // flip of the toggle: the landing redirect above is one-shot, so without
    // this, switching modes from Setup would leave you on a tab that no longer
    // has a tab-bar entry. Setup stays reachable in both modes — it is where
    // the toggle lives, and a mode you cannot leave is a trap.
    if (remoteOnly) {
      if (leaf !== 'remote' && leaf !== 'setup') router.replace('/(tabs)/remote');
      return;
    }
    if (leaf === 'remote') {
      router.replace('/(tabs)');
      return;
    }
    if ((hidePad && leaf === 'pad') || (hideLaunch && leaf === 'launch')) {
      router.replace('/(tabs)');
    }
  }, [ready, hidePad, hideLaunch, remoteOnly, segments]);

  return (
    <>
    <Tabs
      screenListeners={{ tabPress: () => hapticSelection() }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.blue,
        tabBarInactiveTintColor: t.textFaint,
        tabBarStyle: {
          backgroundColor: t.tabBar,
          borderTopColor: t.tabBarBorder,
        },
        sceneStyle: { backgroundColor: t.bg },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Console',
          tabBarIcon: ({ color }) => <Ionicons name="pulse" size={24} color={color} />,
          // A box dashboard with no box is an empty screen, so Console goes too
          // in remote-only mode — the only tab left is the Remote (plus Setup).
          href: remoteOnly ? null : undefined,
        }}
      />
      {/* The TV remote. Present only in remote-only mode: a box owner already
          has a richer remote inside the Pad tab (it reaches CEC, RS-232 and the
          box's own volume through the agent), and two remotes in one tab bar
          would be a question the user has to answer on every press. */}
      <Tabs.Screen
        name="remote"
        options={{
          title: 'Remote',
          tabBarIcon: ({ color }) => <Ionicons name="tv" size={24} color={color} />,
          href: remoteOnly ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="fleet"
        options={{
          title: 'Fleet',
          tabBarIcon: ({ color }) => <Ionicons name="server" size={24} color={color} />,
          // Only useful with several boxes; single-box users keep a clean bar.
          href: !remoteOnly && boxes.length >= 2 ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="actions"
        options={{
          title: 'Actions',
          tabBarIcon: ({ color }) => <Ionicons name="flash" size={24} color={color} />,
          href: remoteOnly ? null : undefined,
        }}
      />
      <Tabs.Screen
        name="pad"
        options={{
          title: 'Pad',
          tabBarIcon: ({ color }) => <Ionicons name="game-controller" size={24} color={color} />,
          // Hidden on a server box (no virtual gamepad). null = no tab bar entry.
          href: hidePad ? null : undefined,
        }}
      />
      <Tabs.Screen
        name="launch"
        options={{
          title: 'Launch',
          tabBarIcon: ({ color }) => <Ionicons name="rocket" size={24} color={color} />,
          // Hidden on a server box (no Steam install). null = no tab bar entry.
          href: hideLaunch ? null : undefined,
        }}
      />
      {/* No Watch tab: it is a SEGMENT of Launch (components/WatchPanel).
          Launch already means "start something on the TV", the bar was getting
          crowded at six, and nesting is safe rather than hopeful — the agent's
          player_available() requires steam + steamos-add-to-steam, so
          `player: true` implies Steam is present and Launch is never hidden on a
          box that has Watch. One door per thing, same as Steam menus moving into
          a Pad segment. */}
      <Tabs.Screen
        name="setup"
        options={{
          title: 'Setup',
          tabBarIcon: ({ color }) => <Ionicons name="settings-sharp" size={24} color={color} />,
        }}
      />
    </Tabs>
    {tour.visible ? (
      <FeatureTour
        state={tour.state}
        tabOrder={tabOrder}
        onNext={tourNext}
        onSkip={tour.skip}
      />
    ) : null}
    </>
  );
}
