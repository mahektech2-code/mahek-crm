import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  LayoutAnimation,
  PanResponder,
  Pressable,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { weight } from '../../theme/tokens';
import { DUR, staggerDelay } from './route-motion';
import { feedback } from './feedback';
import type { FeedbackKind } from '../../engines/feedback';

export { ROUTE_MOTION, animationFor, durationFor, DUR, type ScreenMotion } from './route-motion';

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
 * that is where it will go back down to. A row that is done leaves; a row that
 * arrives settles; a number that changed counts to its new value so the eye
 * can see that it moved.
 *
 * The durations are short on purpose. This is used one-handed, standing up, in
 * a market, by somebody who has done it four hundred times this month.
 *
 * NO REANIMATED, deliberately. It was removed with worklets and
 * gesture-handler to make the APK lean (0ae86207), and nothing here needs it:
 * every transform and opacity below runs on the native driver, which is the
 * same UI-thread animation without the library. The few things that cannot —
 * a bar's width, a number counting, an SVG stroke — are short, one-off, and run
 * on the JS driver where a dropped frame costs nothing.
 */

/** The design's own curve, cubic-bezier(0.2, 0, 0.2, 1) — quick to leave, slow to settle. */
export const EASE = Easing.bezier(0.2, 0, 0.2, 1);
const EASE_IN = Easing.bezier(0.4, 0, 1, 1);

/* -------------------------------------------------------- reduced motion */

/**
 * The design says `prefers-reduced-motion: reduce` turns everything off, and
 * that is not a nicety — for some people this movement causes nausea.
 *
 * Read once at import and watched for the life of the process, so the hook
 * starts from the real answer instead of `false` — a component mounted after
 * the first read no longer plays one frame of movement before it learns it
 * should not. `isReduceMotion()` is the same answer for code that is not a
 * component, `animateLayout` among it.
 */
let reduceNow = false;
const reduceListeners = new Set<(v: boolean) => void>();
void AccessibilityInfo.isReduceMotionEnabled()
  .then((v) => {
    reduceNow = v;
    reduceListeners.forEach((l) => l(v));
  })
  .catch(() => {});
AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
  reduceNow = v;
  reduceListeners.forEach((l) => l(v));
});

export function isReduceMotion(): boolean {
  return reduceNow;
}

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(reduceNow);
  React.useEffect(() => {
    reduceListeners.add(setReduce);
    setReduce(reduceNow);
    return () => {
      reduceListeners.delete(setReduce);
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
 * It also covers something real. Every screen reads SQLite, so there is a
 * frame or two where the lists are empty; fading in over that reads as the
 * screen arriving rather than as data popping in late.
 */
export function Appear({
  children,
  delay = 0,
  distance = 8,
  duration = DUR.settle,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  distance?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const progress = React.useRef(new Animated.Value(reduce || duration === 0 ? 1 : 0)).current;

  React.useEffect(() => {
    if (reduce || duration === 0) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      easing: EASE,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, delay, duration, reduce]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
        },
      ]}>
      {children}
    </Animated.View>
  );
}

/**
 * A list arriving, one row after another.
 *
 * Only the first eight rows wait their turn (`STAGGER_CAP`); everything past
 * them appears with the eighth. A cascade down a list of four hundred shops is
 * a wait dressed up as polish — and the rows below the fold are not on screen
 * to be seen settling anyway.
 *
 * Wrap the ROW, keyed as the list already keys it: `<Stagger index={i}>`. It
 * plays once, when the row mounts, so filtering a list re-staggers only the
 * rows that are new to it.
 */
export function Stagger({
  index,
  children,
  style,
}: {
  index: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const delay = staggerDelay(index);
  return (
    <Appear delay={delay ?? staggerDelay(7) ?? 0} distance={6} duration={DUR.quick + 40} style={style}>
      {children}
    </Appear>
  );
}

/* ------------------------------------------------------------------ layout */

/**
 * The next layout change animates instead of jumping.
 *
 * Call it immediately BEFORE the state change that adds, removes or resizes
 * something — a row leaving a list, a section opening, a filter narrowing the
 * book. React Native's own `LayoutAnimation` then moves every affected view to
 * its new place on the UI thread; no view has to know it is being moved.
 *
 * NOT FOR LONG LISTS. It animates every view whose frame changed, and on the
 * customers list that is a thousand rows on a phone with 2 GB of memory. The
 * screens that render big lists call `animateLayoutFor(count)`, and the
 * threshold is here so it is one number.
 */
export const LAYOUT_ANIMATION_ROW_LIMIT = 60;

export function animateLayout(duration: number = DUR.quick + 20): void {
  if (reduceNow) return;
  try {
    LayoutAnimation.configureNext({
      duration,
      create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeIn, property: LayoutAnimation.Properties.opacity },
    });
  } catch {
    /* A layout that jumps is a layout that still works. */
  }
}

/** `animateLayout`, unless the list it would move is too long to move cheaply. */
export function animateLayoutFor(rowCount: number): void {
  if (rowCount <= LAYOUT_ANIMATION_ROW_LIMIT) animateLayout();
}

/* ---------------------------------------------------------------- presence */

/**
 * Something that comes and goes in place — a refusal under a button, the list
 * of conditions under a locked rung, an error under a field.
 *
 * It fades and drops in on the way in and plays the same thing backwards on
 * the way out, and the space around it opens and closes with it rather than
 * snapping. Without this, a reason appearing under a button shoves the whole
 * form down a line in one frame, which is precisely when somebody is about to
 * tap the thing that just moved.
 */
export function Presence({
  show,
  children,
  style,
  distance = -6,
}: {
  show: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Negative drops it from above, which suits a message hanging under what caused it. */
  distance?: number;
}) {
  const reduce = useReduceMotion();
  const progress = React.useRef(new Animated.Value(show ? 1 : 0)).current;
  const [mounted, setMounted] = React.useState(show);
  /* Children are held while leaving, so the exit shows what is leaving rather
     than an empty box — a caller usually renders nothing once `show` is false.
     Recorded after each commit in which it was shown, so the ref is never
     written during render. */
  const held = React.useRef<React.ReactNode>(children);
  React.useEffect(() => {
    if (show) held.current = children;
  });

  if (show && !mounted) {
    animateLayout();
    setMounted(true);
  }

  React.useEffect(() => {
    if (!mounted) return;
    if (reduce) {
      progress.setValue(show ? 1 : 0);
      if (!show) setMounted(false);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: show ? 1 : 0,
      duration: show ? DUR.settle : DUR.quick - 40,
      easing: show ? EASE : EASE_IN,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished && !show) {
        animateLayout();
        setMounted(false);
      }
    });
    return () => anim.stop();
  }, [show, mounted, reduce, progress]);

  if (!mounted) return null;
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
        },
      ]}>
      {show ? children : held.current}
    </Animated.View>
  );
}

/**
 * One state replacing another in the same place — the visit card going from
 * "travelling" to "checked in", the status strip going from offline to synced.
 *
 * Keyed on `id`: when it changes, the new content settles in and the box
 * around it eases to its new height. The old content is not faded out first;
 * holding it would put both states on screen at once, and for a moment the
 * card would claim two things. The FIRST render does not animate — a screen
 * opening on a state is not that state changing.
 */
export function Swap({
  id,
  children,
  style,
}: {
  id: string | number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [initial] = React.useState(id);
  const [prev, setPrev] = React.useState(id);
  if (prev !== id) {
    animateLayout();
    setPrev(id);
  }
  const still = id === initial;
  return (
    <Appear key={String(id)} distance={still ? 0 : 4} duration={still ? 0 : DUR.quick + 20} style={style}>
      {children}
    </Appear>
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
 * A tappable card — a customer, a stop, a lead, a tile on More — with the same
 * press the buttons have.
 *
 * The cards are the biggest touch targets in the app and the ones tapped most,
 * and they gave nothing back but a background tint some of them did not even
 * have. A card is bigger than a button, so it gives a little more (0.98):
 * the same 1.5% on a full-width card is invisible.
 *
 * LAYOUT GOES ON THE OUTSIDE, appearance on the inside, for the reason
 * `primitives.tsx` spells out at `splitStyle`: `outerStyle` carries the flex and
 * the margins, `style` the card's own look.
 */
export function PressableScale({
  children,
  style,
  outerStyle,
  scaleTo = 0.98,
  feedbackKind,
  onPress,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  children: React.ReactNode;
  style?: PressableProps['style'];
  outerStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
  /** A buzz on the press, for the few taps that ARE an outcome. Most cards pass none. */
  feedbackKind?: FeedbackKind;
}) {
  const press = usePressScale(scaleTo);
  return (
    <Animated.View style={[!disabled && press.style, outerStyle]}>
      <Pressable
        {...rest}
        disabled={disabled}
        onPressIn={(e) => {
          press.onPressIn();
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          press.onPressOut();
          onPressOut?.(e);
        }}
        onPress={(e) => {
          if (feedbackKind) feedback(feedbackKind);
          onPress?.(e);
        }}
        style={style}>
        {children}
      </Pressable>
    </Animated.View>
  );
}

/* ---------------------------------------------------------------- refusal */

/**
 * The refusal shake: three short swings, 240 ms, 4px. It says "no" the way a
 * head does, and it is the only motion in the app that moves sideways inside a
 * screen — which is why it is never used for anything but a refusal.
 *
 * `shake()` also buzzes `warning`, because a refusal felt but not seen is the
 * ordinary case on a phone held at waist height.
 */
export function useShake(kind: FeedbackKind | null = 'warning') {
  const x = React.useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();
  const shake = React.useCallback(() => {
    if (kind) feedback(kind);
    if (reduce) return;
    x.setValue(0);
    const step = (to: number) =>
      Animated.timing(x, { toValue: to, duration: 40, easing: Easing.linear, useNativeDriver: true });
    Animated.sequence([step(4), step(-4), step(3), step(-3), step(2), step(0)]).start();
  }, [x, reduce, kind]);
  return { shake, style: { transform: [{ translateX: x }] } };
}

/* -------------------------------------------------------------------- pop */

/**
 * Something new that matters — a badge count rising, a tick, a rung reached.
 *
 * It grows from 60% with a small overshoot and fades in, keyed on `trigger`:
 * every time the trigger changes it pops again, which is how a badge going
 * from 2 to 3 is noticed when a digit changing in place would not be. The
 * first render does not pop — a badge that was already there is not news.
 */
export function Pop({
  trigger,
  children,
  style,
  from = 0.6,
  popOnMount = false,
}: {
  trigger: unknown;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  from?: number;
  /** Pop on the first render too — for a badge that appears BECAUSE something arrived. */
  popOnMount?: boolean;
}) {
  const reduce = useReduceMotion();
  const [startsHidden] = React.useState(popOnMount && !reduce);
  const v = React.useRef(new Animated.Value(startsHidden ? 0 : 1)).current;
  const seen = React.useRef<unknown>(startsHidden ? Symbol('unseen') : trigger);

  React.useEffect(() => {
    if (Object.is(seen.current, trigger)) return;
    seen.current = trigger;
    if (reduce) {
      v.setValue(1);
      return;
    }
    v.setValue(0);
    Animated.spring(v, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 9 }).start();
  }, [trigger, reduce, v]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [from, 1] }) }],
        },
      ]}>
      {children}
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ pulse */

/**
 * Something live — syncing, travelling, waiting on the radio.
 *
 * A slow breath between full and 40% opacity. Off entirely under reduced
 * motion, where a looping animation is exactly what the setting asks us not to
 * do, and off when `active` is false so a finished sync stops breathing.
 */
export function Pulse({
  active,
  children,
  style,
}: {
  active: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const v = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    if (!active || reduce) {
      v.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      v.setValue(1);
    };
  }, [active, reduce, v]);
  return <Animated.View style={[style, { opacity: v }]}>{children}</Animated.View>;
}

/* ---------------------------------------------------------------- numbers */

/**
 * A number that changed, counting to its new value.
 *
 * The count is the point: a performance score that is simply 72 when it was 64
 * this morning says nothing about having moved; one that runs from 64 to 72
 * says it did. On FIRST mount it counts up from zero only when `fromZero` is
 * set — a figure that is not news should simply be there.
 *
 * `format` turns the number into what is drawn, so rupees, percentages and
 * plain counts all go through one component. JS-driven: text cannot be
 * animated on the native driver, and these run for 600 ms on a handful of
 * figures. The accessibility label is always the FINAL figure, so a screen
 * reader never announces a number on its way somewhere.
 */
export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  fromZero = false,
  duration = 600,
  style,
  numberOfLines,
}: {
  value: number;
  format?: (n: number) => string;
  fromZero?: boolean;
  duration?: number;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const reduce = useReduceMotion();
  const start = fromZero && !reduce && Number.isFinite(value) ? 0 : value;
  const [shown, setShown] = React.useState(start);
  const fromRef = React.useRef(start);

  React.useEffect(() => {
    const from = fromRef.current;
    if (reduce || from === value || !Number.isFinite(value) || !Number.isFinite(from)) {
      fromRef.current = value;
      setShown(value);
      return;
    }
    const v = new Animated.Value(from);
    const id = v.addListener(({ value: n }) => setShown(n));
    const anim = Animated.timing(v, { toValue: value, duration, easing: EASE, useNativeDriver: false });
    anim.start(() => setShown(value));
    fromRef.current = value;
    return () => {
      anim.stop();
      v.removeListener(id);
    };
  }, [value, reduce, duration]);

  return (
    <Text style={style} numberOfLines={numberOfLines} accessibilityLabel={format(value)}>
      {format(shown)}
    </Text>
  );
}

/**
 * A progress track filling to its value. Same look as `Bar`; the fill moves.
 *
 * Width, so the JS driver — the native driver cannot animate a percentage
 * width, and scaling instead would squash the rounded ends into ellipses.
 */
export function FillBar({
  pct,
  fill,
  track,
  height = 8,
  delay = 0,
}: {
  pct: number;
  fill: string;
  track: string;
  height?: number;
  delay?: number;
}) {
  const reduce = useReduceMotion();
  const target = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
  const v = React.useRef(new Animated.Value(reduce ? target : 0)).current;

  React.useEffect(() => {
    if (reduce) {
      v.setValue(target);
      return;
    }
    const anim = Animated.timing(v, { toValue: target, duration: 520, delay, easing: EASE, useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [target, reduce, v, delay]);

  return (
    <Animated.View style={{ flex: 1, height, borderRadius: height / 2, backgroundColor: track, overflow: 'hidden' }}>
      <Animated.View
        style={{
          width: v.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
          height: '100%',
          borderRadius: height / 2,
          backgroundColor: fill,
        }}
      />
    </Animated.View>
  );
}

/* ------------------------------------------------------------------- tick */

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * The tick that is drawn rather than shown — the visit receipt, a day started.
 *
 * A circle that grows in, then a stroke that writes itself left to right,
 * about 320 ms in all. It is the one place in the app allowed to take its
 * time, because it marks the end of a piece of work rather than a step inside
 * one; and it fires `success` as the stroke lands, so the buzz and the mark
 * are one moment.
 */
export function DrawnTick({
  size = 72,
  color,
  background,
  buzz = true,
}: {
  size?: number;
  color: string;
  background: string;
  buzz?: boolean;
}) {
  const reduce = useReduceMotion();
  const circle = React.useRef(new Animated.Value(reduce ? 1 : 0)).current;
  const stroke = React.useRef(new Animated.Value(reduce ? 1 : 0)).current;
  const LENGTH = 26;

  React.useEffect(() => {
    if (reduce) {
      if (buzz) feedback('success');
      return;
    }
    const anim = Animated.sequence([
      Animated.spring(circle, { toValue: 1, useNativeDriver: false, speed: 16, bounciness: 8 }),
      Animated.timing(stroke, { toValue: 1, duration: 220, easing: EASE, useNativeDriver: false }),
    ]);
    anim.start(({ finished }) => {
      if (finished && buzz) feedback('success');
    });
    return () => anim.stop();
  }, [reduce, circle, stroke, buzz]);

  return (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel="Done"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: circle.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [{ scale: circle.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }],
      }}>
      <Svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24">
        <AnimatedPath
          d="M4 12.5l5.2 5.2L20 7"
          fill="none"
          stroke={color}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={LENGTH}
          strokeDashoffset={stroke.interpolate({ inputRange: [0, 1], outputRange: [LENGTH, 0] })}
        />
      </Svg>
    </Animated.View>
  );
}

/* ------------------------------------------------------------- swipe row */

export type SwipeAction = {
  /** What it does, in two or three words — drawn under the row as it is uncovered. */
  label: string;
  /** The colour the row uncovers. Green for done, the brand colour for "go there". */
  color: string;
  run: () => void;
};

/**
 * A row that can be swiped to act on it — a task ticked off, a shop rung.
 *
 * THE SWIPE IS A SHORTCUT, NEVER THE ONLY WAY. Every action offered here is
 * also a button on the row or on the screen it opens, because a gesture
 * nobody has been shown does not exist for the person who has not found it,
 * and a salesman with a phone in a plastic cover finds very few.
 *
 * Past 40% of the row it commits: the row slides the rest of the way, buzzes
 * `success`, and the action runs — the caller removes the row (with
 * `animateLayout()` first, so the list closes the gap rather than jumping).
 * Short of that, it springs back and nothing happened. Only a horizontal drag
 * claims the touch, so the list still scrolls under a thumb moving mostly
 * up or down.
 */
export function SwipeRow({
  children,
  right,
  left,
  style,
}: {
  children: React.ReactNode;
  /** Revealed by swiping LEFT — the row moves left, the action sits on the right. */
  right?: SwipeAction;
  /** Revealed by swiping RIGHT. */
  left?: SwipeAction;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const x = React.useRef(new Animated.Value(0)).current;
  const [width, setWidth] = React.useState(360);
  const widthRef = React.useRef(width);
  const actions = React.useRef({ left, right });
  const [side, setSide] = React.useState<'left' | 'right' | null>(null);
  React.useEffect(() => {
    widthRef.current = width;
    actions.current = { left, right };
  });

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => {
          if (Math.abs(g.dx) < 12 || Math.abs(g.dx) < Math.abs(g.dy) * 1.6) return false;
          return g.dx < 0 ? !!actions.current.right : !!actions.current.left;
        },
        onPanResponderGrant: (_e, g) => setSide(g.dx < 0 ? 'right' : 'left'),
        onPanResponderMove: (_e, g) => {
          const allowed = g.dx < 0 ? !!actions.current.right : !!actions.current.left;
          x.setValue(allowed ? g.dx : g.dx / 6);
        },
        onPanResponderRelease: (_e, g) => {
          const w = widthRef.current;
          const action = g.dx < 0 ? actions.current.right : actions.current.left;
          if (action && Math.abs(g.dx) > w * 0.4) {
            feedback('success');
            Animated.timing(x, {
              toValue: g.dx < 0 ? -w : w,
              duration: reduce ? 0 : 160,
              easing: EASE,
              useNativeDriver: true,
            }).start(() => {
              action.run();
              /* Back to rest, in case the caller keeps the row (an undo, a
                 refusal) rather than removing it. */
              x.setValue(0);
              setSide(null);
            });
          } else {
            Animated.spring(x, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 3 }).start(() =>
              setSide(null),
            );
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(() => setSide(null));
        },
      }),
    [x, reduce],
  );

  const shown = side === 'right' ? right : side === 'left' ? left : null;

  return (
    <View style={style} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {shown ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: shown.color,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: side === 'right' ? 'flex-end' : 'flex-start',
            paddingHorizontal: 20,
          }}>
          <Text style={[{ color: '#FFFFFF', fontSize: 14 }, weight(600)]}>{shown.label}</Text>
        </View>
      ) : null}
      <Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}
