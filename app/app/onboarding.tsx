/**
 * First run: welcome, which device, and the first real task.
 *
 * A Stack screen BESIDE (tabs), never inside it — the tab bar must not render
 * behind this, and the tab layout's own redirects must not race it.
 *
 * WHY A CHOOSER IN THE MIDDLE. The zero-box Setup screen opens by telling you to
 * install a service on "the box you want to control", which is a dead end for
 * the smart-TV-only audience remote-only mode was built for: they have to scroll
 * past an installer tutorial that cannot apply to them. This routes each
 * audience to its own first step instead of making one read the other's
 * instructions. See docs/memory/project_first-run-mode-chooser.md.
 *
 * THE HARD PART IS ON ANOTHER MACHINE. The phone cannot run the installer, cannot
 * see the box's terminal, and cannot tell a finished install from a failed one.
 * Every product that solves this well — Hue's "is the LED blinking? Tap yes",
 * Sonos pre-announcing its chime — uses the USER as the sensor it does not have.
 * So the install screen ends in a question about what the box printed, and the
 * answer routes: the fast path is scanning the link the installer puts on the TV,
 * not a 254-address sweep of the LAN.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DirectTvSetup } from '@/components/DirectTvSetup';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { hapticLight, hapticSelection } from '@/lib/haptics';
import {
  backFrom,
  FIRST_STEP,
  INSTALL_COMMAND,
  isExit,
  stepForChoice,
  type DeviceChoice,
  type OnboardingStep,
} from '@/lib/onboarding';
import { setPref } from '@/lib/prefs';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export default function Onboarding() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // Portrait, like every tab except Pad. This route lives OUTSIDE the tab group,
  // so it does not inherit their lock — without this the first-run flow is the
  // one screen in the app that can rotate, and it has a long copy block and a
  // command line that reflow badly in landscape.
  useLockOrientation('portrait');
  const [step, setStep] = useState<OnboardingStep>(FIRST_STEP);
  const [copied, setCopied] = useState(false);

  /**
   * Leave for good. AWAITS the pref writes before navigating: the tab layout
   * reads remoteOnlyMode to decide which tabs exist, so navigating first would
   * flash the wrong tab bar. `onboardingDone` is set on EVERY exit — finishing,
   * skipping, or backing off the first screen — because a flow that reappears
   * after a deliberate back-out is a nag.
   */
  const leave = useCallback(async (remoteOnly?: boolean) => {
    if (remoteOnly) await setPref('remoteOnlyMode', true);
    await setPref('onboardingDone', true);
    router.replace('/(tabs)/setup');
  }, []);

  // Android hardware back. Inside the flow it is a STEP back; only off the first
  // screen is it an exit. Conflating those would mark onboarding finished the
  // moment someone backed out of the install screen to re-read the chooser.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const prev = backFrom(step);
      if (prev) {
        setStep(prev);
        return true; // handled: stay in the flow
      }
      if (isExit(step, 'back')) void leave();
      return true;
    });
    return () => sub.remove();
  }, [step, leave]);

  const choose = (c: DeviceChoice) => {
    hapticSelection();
    setStep(stepForChoice(c));
  };

  const copyCommand = async () => {
    hapticLight();
    await Clipboard.setStringAsync(INSTALL_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {step === 'welcome' ? (
            <>
              <View style={styles.badge}>
                <Ionicons name="game-controller" size={22} color={t.green} />
              </View>
              <Text style={styles.h1}>Your phone, running the machine under the TV</Text>
              <Text style={styles.body1}>
                Couchside turns this phone into the dashboard, the remote and the controller for
                your living-room box.
              </Text>
              <Text style={styles.body1}>
                No accounts and no cloud — it talks to the machine directly over your Wi-Fi.
              </Text>
            </>
          ) : null}

          {step === 'choose' ? (
            <>
              <Text style={styles.h1}>What are we setting up?</Text>
              {/* NEITHER card says "recommended". This screen exists precisely
                  because neither audience is the default one. */}
              <Pressable
                onPress={() => choose('box')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <Ionicons name="hardware-chip-outline" size={20} color={t.green} />
                <Text style={styles.cardTitle}>A gaming machine</Text>
                <Text style={styles.cardBody}>
                  Steam Deck, Bazzite box, gaming PC. Launch games, fix a black screen, and use
                  the phone as a gamepad.
                </Text>
              </Pressable>
              <Pressable
                onPress={() => choose('tv')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <Ionicons name="tv-outline" size={20} color={t.blue} />
                <Text style={styles.cardTitle}>Just a smart TV</Text>
                {/* Names what works TODAY. Same honesty rule as DirectTvSetup. */}
                <Text style={styles.cardBody}>
                  Roku today. LG, Samsung and Google TV need a Couchside box.
                </Text>
              </Pressable>
            </>
          ) : null}

          {step === 'install' ? (
            <>
              <Text style={styles.h1}>This part happens on the box</Text>
              <Text style={styles.body1}>
                Your phone has no way in yet — this line is what fixes that. Sit down at the box,
                open a terminal, and run:
              </Text>
              <View style={styles.cmdWrap}>
                <Text style={styles.cmd} selectable>
                  {INSTALL_COMMAND}
                </Text>
              </View>
              <Pressable
                onPress={copyCommand}
                accessibilityRole="button"
                accessibilityLabel="Copy the install command"
                style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}>
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={15}
                  color={copied ? t.green : t.textDim}
                />
                <Text style={[styles.ghostText, copied && { color: t.green }]}>
                  {copied ? 'COPIED' : 'COPY'}
                </Text>
              </Pressable>
              <Text style={styles.note}>On a Steam Deck, switch to Desktop Mode first.</Text>
              {/* SteamOS ships the 'deck' user with NO password, so sudo refuses
                  and the installer stops partway. install.sh detects this and
                  says so — but only AFTER you have run it and hit the wall,
                  which on a Deck is most people. Saying it first turns a failed
                  run into a step. */}
              <View style={styles.warn}>
                <Ionicons name="information-circle-outline" size={16} color={t.amber} />
                <Text style={styles.warnText}>
                  First time on a Steam Deck? Run <Text style={styles.inline}>passwd</Text> before
                  the line above — SteamOS ships without one, and the installer needs sudo. On
                  Bazzite the password is usually <Text style={styles.inline}>bazzite</Text> unless
                  you changed it.
                </Text>
              </View>

              {/* THE USER IS THE SENSOR. The phone cannot see the box's terminal,
                  so it asks — and the answer routes, rather than dropping
                  everyone into the same LAN sweep. */}
              <Text style={styles.h2}>When it finishes</Text>
              <Text style={styles.body1}>
                The box prints a banner ending in{' '}
                <Text style={styles.inline}>Couchside agent is running on …:8787</Text>, and a link
                underneath it.
              </Text>
              <Text style={styles.note}>
                Scanning that link with your camera is the quickest way in — quicker than waiting
                for this phone to find the box by itself.
              </Text>
            </>
          ) : null}

          {step === 'tv' ? (
            <>
              <Text style={styles.h1}>Set up your TV</Text>
              <DirectTvSetup />
            </>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          {step === 'welcome' ? (
            <Pressable
              onPress={() => {
                hapticLight();
                setStep('choose');
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>GET STARTED</Text>
            </Pressable>
          ) : null}

          {step === 'install' ? (
            <Pressable
              onPress={() => {
                hapticLight();
                void leave();
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>IT&apos;S RUNNING — FIND IT</Text>
            </Pressable>
          ) : null}

          {step === 'tv' ? (
            <Pressable
              onPress={() => {
                hapticLight();
                void leave(true);
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>DONE</Text>
            </Pressable>
          ) : null}

          {/* An escape on EVERY screen. A first run you cannot leave is a wall,
              and the measured funnel problem is people bouncing, not choosing
              wrong. */}
          <Pressable
            onPress={() => {
              hapticLight();
              void leave();
            }}
            accessibilityRole="button"
            accessibilityLabel="Skip setup for now"
            style={({ pressed }) => [styles.skip, pressed && styles.pressed]}>
            <Text style={styles.skipText}>
              {step === 'choose' ? "I'll decide later" : 'Skip for now'}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 20 },
    body: { paddingTop: 16, paddingBottom: 24, gap: 14 },
    badge: {
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
      marginBottom: 4,
    },
    h1: { color: t.text, fontSize: 25, fontWeight: '800', lineHeight: 31 },
    h2: { color: t.text, fontSize: 16, fontWeight: '800', marginTop: 10 },
    body1: { color: t.textDim, fontSize: 14.5, lineHeight: 21 },
    note: { color: t.textFaint, fontSize: 12.5, lineHeight: 18 },
    warn: {
      flexDirection: 'row',
      gap: 9,
      alignItems: 'flex-start',
      backgroundColor: t.inset,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: t.cardBorder,
      padding: 12,
    },
    warnText: { color: t.textDim, fontSize: 12.5, lineHeight: 18, flex: 1 },
    inline: { color: t.text, fontFamily: mono, fontSize: 13 },
    card: {
      backgroundColor: t.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: t.cardBorder,
      padding: 16,
      gap: 7,
    },
    cardTitle: { color: t.text, fontSize: 17, fontWeight: '800' },
    cardBody: { color: t.textDim, fontSize: 13.5, lineHeight: 19 },
    cmdWrap: {
      backgroundColor: t.inset,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: t.cardBorder,
      paddingVertical: 12,
      paddingHorizontal: 13,
    },
    cmd: { color: t.green, fontFamily: mono, fontSize: 13, lineHeight: 19 },
    ghost: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: t.cardBorder,
      backgroundColor: t.inset,
    },
    ghostText: { color: t.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
    footer: { gap: 8, paddingTop: 6 },
    primary: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 13,
      paddingVertical: 15,
      backgroundColor: t.green,
    },
    primaryText: { color: t.onGreen, fontSize: 13.5, fontWeight: '900', letterSpacing: 1, fontFamily: mono },
    skip: { alignItems: 'center', paddingVertical: 11 },
    skipText: { color: t.textFaint, fontSize: 13 },
    pressed: { opacity: 0.75 },
  });
