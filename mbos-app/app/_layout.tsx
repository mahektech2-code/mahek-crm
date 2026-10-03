import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { color } from '../src/theme/tokens';
import { BootProvider } from '../src/state/boot';
import { AppLock } from '../src/components/shell/AppLock';
import { PushTaps } from '../src/state/push-taps';
import { UpdatePrompt } from '../src/components/shell/UpdatePrompt';
import { PushBanner } from '../src/components/shell/PushBanner';
import { animationFor, durationFor, ROUTE_MOTION, useReduceMotion } from '../src/components/ui/motion';
/* Side-effect only: registers the trail's background task. The OS can launch
   the app headless, with no screen ever mounted, purely to deliver a location
   and run it — so this has to load on every bundle start, not on the first
   screen that happens to import it. See `sync/trail.ts`. */
import '../src/sync/trail';
/* Same reason, for the sync loop's own background task. See
   `sync/background-sync-task.ts`. */
import '../src/sync/background-sync-task';

/* Called in global scope and deliberately not awaited — that is what its own
   documentation asks for, and awaiting it inside a hook races the first paint. */
SplashScreen.preventAutoHideAsync();

export const unstable_settings = { anchor: 'index' };

/**
 * A crash anywhere in the app lands HERE rather than on a white screen.
 *
 * There was no boundary at all, so any error React could not place — the
 * dictation sheet's recorder read after release was the one that found this
 * — unmounted the whole tree and left a blank page. A salesman reads a blank
 * page as a hung phone, force-closes, and nobody ever learns what broke.
 *
 * Plain React Native and nothing else: a fallback that leaned on the app's
 * own providers could fail for the same reason the screen it replaces did.
 * The error's own message is printed, because "it went white" is the whole
 * of the bug report otherwise.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: color.canvas }}>
      <Text style={{ fontSize: 20, fontWeight: '600', color: color.ink }}>Something went wrong on this screen</Text>
      <Text style={{ fontSize: 15, lineHeight: 21, color: color.body, marginTop: 10 }}>
        Anything you already saved is safe on the phone. Tap below to carry on. If it keeps
        happening, send your manager a photo of this screen.
      </Text>
      <Text selectable style={{ fontSize: 13, color: color.muted, marginTop: 14 }}>
        {error?.message || String(error)}
      </Text>
      <Pressable
        onPress={() => void retry()}
        style={{
          marginTop: 24,
          height: 48,
          borderRadius: 12,
          backgroundColor: color.primary,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: '#FFFFFF' }}>Carry on</Text>
      </Pressable>
    </View>
  );
}

/**
 * Three weights, each registered under its own family name.
 *
 * React Native does not synthesise a weight from a family on Android, so
 * `fontFamily: 'Inter'` with `fontWeight: '600'` renders regular there and
 * semibold on iOS — the kind of difference nobody notices until the two
 * phones are next to each other. The weight is in the name instead.
 */
export default function RootLayout() {
  const [loaded, error] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  const reduce = useReduceMotion();

  React.useEffect(() => {
    if (loaded || error) SplashScreen.hide();
  }, [loaded, error]);

  /* A font that failed to load is not a reason to show nothing — `error` lets
     the app through on the system face rather than holding a blank screen. */
  if (!loaded && !error) return null;

  return (
    <BootProvider>
      <StatusBar style="dark" />
      {/* Over the whole Stack, so a lock raised on any screen covers the header
          and the tab bar too — and inside BootProvider, because there is
          nothing to lock until there is a session. */}
      {/* Renders nothing; it exists so a tapped push opens what it is about,
          including the tap that cold-starts the app. */}
      <PushTaps />
      <AppLock>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: color.canvas },
            /* The default is depth. Every screen that is NOT deeper says so
               below, which makes the exceptions the thing you read. */
            animation: animationFor('deeper', reduce),
            animationDuration: durationFor('deeper', reduce),
            /* iOS keeps its edge-swipe back; it is the gesture people already
               have in their hands and losing it is worse than any transition. */
            gestureEnabled: true,
          }}>
          {Object.entries(ROUTE_MOTION).map(([name, motion]) => (
            <Stack.Screen
              key={name}
              name={name}
              options={{
                animation: animationFor(motion, reduce),
                animationDuration: durationFor(motion, reduce),
                /* Nothing swipes back out of a result — there is no longer
                   anywhere behind it to go. */
                gestureEnabled: motion !== 'result',
              }}
            />
          ))}
        </Stack>
        {/* Once, here, rather than in AppFrame: every screen in the stack has
            its own frame, and a modal that runs a download must not open as
            several copies, one per screen behind the one he is looking at. */}
        <UpdatePrompt />
        {/* Over every screen, under the lock: a push that lands while the app
            is open is drawn by the app, and never over a locked screen — a
            refusal's reason is not for whoever picked the phone up. */}
        <PushBanner />
      </AppLock>
    </BootProvider>
  );
}
