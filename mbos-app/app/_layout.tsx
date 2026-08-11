import React from 'react';
import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { color } from '../src/theme/tokens';
import { BootProvider } from '../src/state/boot';
import { animationFor, durationFor, ROUTE_MOTION, useReduceMotion } from '../src/components/ui/motion';

/* Called in global scope and deliberately not awaited — that is what its own
   documentation asks for, and awaiting it inside a hook races the first paint. */
SplashScreen.preventAutoHideAsync();

export const unstable_settings = { anchor: 'index' };

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
    </BootProvider>
  );
}
