import React from 'react';
import { AccessibilityInfo, Animated, Easing, type ViewStyle, type StyleProp } from 'react-native';

/**
 * Movement, and what it is for.
 *
 * One rule governs everything in this file: **an animation should say
 * something about the relationship between what you left and what you
 * arrived at.** Motion that is merely decorative costs time on every single
 * navigation — twenty times an hour for somebody working a calling list — and
 * buys nothing back.
 *
 * So: going deeper slides, because depth has a direction. Switching between
 * siblings fades, because there is no direction to it and a slide would imply
 * one. Something that sits over the app comes up from the bottom, because
 * that is where it will go back down to.
 *
 * The durations are short on purpose. This is used one-handed, standing up, in
 * a market, by somebody who has done it four hundred times this month.
 */

/* -------------------------------------------------------- reduced motion */

/**
 * The design says `prefers-reduced-motion: reduce` turns everything off, and
 * that is not a nicety — for some people this movement causes nausea. The
 * setting is read once and watched, so turning it on mid-session takes effect.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (live) setReduce(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  return reduce;
}

/* --------------------------------------------------------------- entrance */

/**
 * Content arriving.
 *
 * A short fade with a small rise — 8px, not 40 — because the screen has
 * already slid or faded into place and this is the second, quieter half of
 * that: the difference between a screen appearing and a screen *settling*.
 *
 * It also covers something real. Every screen now reads SQLite, so there is a
 * frame or two where the lists are empty; fading in over that reads as the
 * screen arriving rather than as data popping in late.
 */
export function Appear({
  children,
  delay = 0,
  distance = 8,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const progress = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (reduce) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 260,
      delay,
      /* The design's own curve, cubic-bezier(0.2, 0, 0.2, 1) — quick to leave,
         slow to settle, which is what makes it feel like it has weight. */
      easing: Easing.bezier(0.2, 0, 0.2, 1),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, delay, reduce]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) },
          ],
        },
      ]}>
      {children}
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ press */

/**
 * The press.
 *
 * `button:active { transform: scale(0.985) }` is in the design's stylesheet and
 * it is the smallest animation here and the one people actually feel: it is the
 * difference between a button that responded and a button you are not sure you
 * hit. On a bad connection, when nothing else has happened yet, it is the only
 * feedback there is.
 *
 * Scale only — no opacity — so it reads as pressed rather than as disabled.
 */
export function usePressScale(to = 0.985) {
  const reduce = useReduceMotion();
  const scale = React.useRef(new Animated.Value(1)).current;

  const spring = React.useCallback(
    (value: number) => {
      if (reduce) return;
      Animated.spring(scale, {
        toValue: value,
        useNativeDriver: true,
        speed: 40,
        bounciness: 0,
      }).start();
    },
    [scale, reduce],
  );

  return {
    scale,
    onPressIn: () => spring(to),
    onPressOut: () => spring(1),
    style: { transform: [{ scale }] },
  };
}

/**
 * A pressable that scales. Used for the big touch targets — the cards, the
 * primary buttons — where the feedback is worth the extra view.
 */
export function PressScale({
  children,
  style,
  ...rest
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
} & Omit<React.ComponentProps<typeof Animated.View>, 'style'>) {
  return (
    <Animated.View style={style} {...rest}>
      {children}
    </Animated.View>
  );
}

/* ------------------------------------------------------------ transitions */

/**
 * Which animation a route gets, and why.
 *
 * Kept here rather than scattered across `Stack.Screen` options so the whole
 * vocabulary can be read at once — and so a new screen has an obvious place to
 * declare what kind of thing it is.
 */
export type ScreenMotion = 'sibling' | 'deeper' | 'over' | 'result' | 'none';

export const ROUTE_MOTION: Record<string, ScreenMotion> = {
  /* The four tabs are siblings. Sliding between them would claim a hierarchy
     that is not there — Customers is not "inside" Home. */
  home: 'sibling',
  journey: 'sibling',
  customers: 'sibling',
  more: 'sibling',

  /* Going into a record, or into a form about one. This is depth, and the
     slide is what makes Back feel like the reverse of it. */
  customer: 'deeper',
  visit: 'deeper',
  order: 'deeper',
  pay: 'deeper',
  samples: 'deeper',
  tasks: 'deeper',
  catalogue: 'deeper',
  attendance: 'deeper',
  leave: 'deeper',
  salary: 'deeper',
  expenses: 'deeper',
  performance: 'deeper',
  docs: 'deeper',
  knowledge: 'deeper',
  profile: 'deeper',
  reports: 'deeper',

  /* Things that sit OVER the day rather than inside it. They come up from the
     bottom because that is where they go back down to. */
  notifications: 'over',
  sync: 'over',
  rejections: 'over',

  /* The visit receipt is not a place you navigated to — it is what happened.
     A slide would invite Back, and there is nothing behind it to go to. */
  saved: 'result',

  /* Signing in replaces the world. */
  index: 'result',
};

type NativeAnimation =
  | 'default' | 'fade' | 'fade_from_bottom' | 'flip' | 'simple_push'
  | 'slide_from_bottom' | 'slide_from_right' | 'slide_from_left' | 'none';

export function animationFor(motion: ScreenMotion, reduce: boolean): NativeAnimation {
  /* Reduced motion keeps the navigation legible without moving anything: a
     fade still tells you the screen changed. */
  if (reduce) return 'fade';

  switch (motion) {
    case 'sibling':
      return 'fade';
    case 'deeper':
      return 'slide_from_right';
    case 'over':
      return 'slide_from_bottom';
    case 'result':
      return 'fade';
    default:
      return 'none';
  }
}

/** Siblings cross-fade quickly; depth is allowed to take its time. */
export function durationFor(motion: ScreenMotion, reduce: boolean): number {
  if (reduce) return 120;
  return motion === 'sibling' || motion === 'result' ? 180 : 260;
}
