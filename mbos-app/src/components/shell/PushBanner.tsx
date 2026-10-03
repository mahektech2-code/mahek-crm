import React from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color as C, radius, weight } from '../../theme/tokens';
import { Icon } from '../ui/Icon';
import { EASE, useReduceMotion } from '../ui/motion';
import { feedback } from '../ui/feedback';
import { feedbackForTone, toneOfNotification, type NotificationTone } from '../../engines/feedback';
import { bannerCanShow, registerBannerHost, useAppLocked } from '../../state/push-banner';
import { openFrom } from '../../state/push-taps';
import { useBoot } from '../../state/boot';
import { syncNow } from '../../sync/engine';

/**
 * A push that arrives while the app is open, drawn by the app.
 *
 * Before this, a decision landing while the salesman was looking at his phone
 * appeared as the system's grey heads-up: dropped over the header, covering
 * the bell it was about, sounding the stock tone at full volume, and in a
 * shape that said nothing about whether it was good news. This drops from
 * under the status bar in the app's own card, with an edge that says what
 * kind of news it is — green for something approved, amber for something
 * refused, the brand colour for everything else — and buzzes once.
 *
 * TAP opens the thing, through the same `openFrom` a tapped system
 * notification uses, so the two can never disagree about where a push goes.
 * SWIPE UP sends it away. A finger RESTING on it holds it, because somebody
 * reading a refusal's reason should not have it taken away mid-sentence.
 *
 * ONE AT A TIME. Three arriving together — the office approving a morning's
 * orders — show the first with "+2 more", and each one after it takes its
 * turn. Three banners stacked over the header would hide the screen they are
 * about.
 *
 * AND IT PULLS. A push says something changed in the office; the message
 * itself reaches the phone's own list on the next sync. Syncing on arrival is
 * what makes the bell's count rise while the banner is still on screen,
 * rather than up to a minute later when the reason for looking has passed.
 */

type Item = {
  id: string;
  title: string;
  body: string;
  data: unknown;
  tone: NotificationTone;
};

const DWELL_MS = 4500;

const LOOK: Record<NotificationTone, { accent: string; tint: string; icon: 'tick' | 'bell' | 'alert' }> = {
  success: { accent: C.success, tint: C.successBg, icon: 'tick' },
  warn: { accent: C.warn, tint: C.warnBg, icon: 'alert' },
  info: { accent: C.primary, tint: C.primaryTint, icon: 'bell' },
};

/**
 * Which tone a push carries. The server sends `tone` from 1.16.0's release;
 * a local reminder (the forgotten check-out, the punch-out prompt) carries
 * none, and is a nudge about something to do now — so it reads as a warning,
 * the same as the system channel's MAX importance says it is.
 */
function toneOf(data: unknown): NotificationTone {
  const d = (data ?? {}) as { tone?: unknown; kind?: unknown };
  if (d.kind === 'forgot-checkout' || d.kind === 'punch-out') return 'warn';
  return toneOfNotification(d.tone);
}

export function PushBanner() {
  const boot = useBoot();
  const signedIn = !!boot.session;
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [queue, setQueue] = React.useState<Item[]>([]);
  const current = queue[0] ?? null;
  const locked = useAppLocked();
  /* Leaving is one-way per item: a tap and the dwell timer landing together,
     or a double tap, must take off ONE banner — each `done` is a `slice(1)`,
     and a second would drop the next push unseen. */
  const leaving = React.useRef<string | null>(null);

  const y = React.useRef(new Animated.Value(0)).current; // 0 hidden, 1 shown
  const drag = React.useRef(new Animated.Value(0)).current;
  const [height, setHeight] = React.useState(96);
  const held = React.useRef(false);

  /* Registered for as long as it is mounted AND somebody is signed in — the
     only time it can actually draw. Signed out, the system banner shows. */
  React.useEffect(() => {
    if (!boot.ready || !signedIn) return;
    return registerBannerHost();
  }, [boot.ready, signedIn]);

  React.useEffect(() => {
    if (!boot.ready || !signedIn) return;
    const sub = Notifications.addNotificationReceivedListener((n) => {
      try {
        const c = n.request.content;
        const item: Item = {
          id: n.request.identifier,
          title: c.title ?? 'MBOS',
          body: c.body ?? '',
          data: c.data,
          tone: toneOf(c.data),
        };
        /* Only what WE are showing: when the app is locked or a sheet is up,
           the handler has already let the system show it. Both read the same
           answer at the same moment, so a push is shown exactly once. */
        if (bannerCanShow()) setQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
        void syncNow().catch(() => {});
      } catch {
        /* A shape this version does not know. The notification is still in the list. */
      }
    });
    return () => sub.remove();
  }, [boot.ready, signedIn]);

  const dismiss = React.useCallback(() => {
    const id = current?.id ?? null;
    if (!id || leaving.current === id) return;
    leaving.current = id;
    const done = () => {
      drag.setValue(0);
      setQueue((q) => (q[0]?.id === id ? q.slice(1) : q));
    };
    if (reduce) {
      y.setValue(0);
      done();
      return;
    }
    Animated.timing(y, { toValue: 0, duration: 180, easing: EASE, useNativeDriver: true }).start(done);
  }, [reduce, y, drag, current]);

  /* Locking takes whatever was showing away — it stays in the phone's
     notification list — rather than leaving it to reappear over the app the
     moment the cover lifts, minutes later and out of context. */
  React.useEffect(() => {
    if (!locked) return;
    y.setValue(0);
    setQueue([]);
  }, [locked, y]);

  const dismissRef = React.useRef(dismiss);
  React.useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);

  /* Each item arrives, is felt once, and leaves on its own after a dwell. */
  React.useEffect(() => {
    if (!current) return;
    feedback(feedbackForTone(current.tone));
    if (reduce) y.setValue(1);
    else Animated.spring(y, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: 5 }).start();

    let t: ReturnType<typeof setTimeout>;
    const arm = () => {
      t = setTimeout(() => {
        if (held.current) arm();
        else dismissRef.current();
      }, DWELL_MS);
    };
    arm();
    return () => clearTimeout(t);
  }, [current, reduce, y]);


  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => {
          held.current = true;
        },
        onPanResponderMove: (_e, g) => drag.setValue(Math.min(g.dy, 24)),
        onPanResponderRelease: (_e, g) => {
          held.current = false;
          if (g.dy < -30 || g.vy < -0.6) dismissRef.current();
          else Animated.spring(drag, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
        },
        onPanResponderTerminate: () => {
          held.current = false;
          Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
        },
      }),
    [drag],
  );

  if (!current || locked) return null;
  const look = LOOK[current.tone];
  const more = queue.length - 1;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        st.wrap,
        {
          top: insets.top + 6,
          opacity: y.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 1] }),
          transform: [
            { translateY: Animated.add(y.interpolate({ inputRange: [0, 1], outputRange: [-(height + insets.top + 12), 0] }), drag) },
          ],
        },
      ]}
      {...pan.panHandlers}>
      <Pressable
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
        onPressIn={() => {
          held.current = true;
        }}
        onPressOut={() => {
          held.current = false;
        }}
        onPress={() => {
          if (leaving.current === current.id) return;
          const data = current.data;
          dismiss();
          void openFrom(data).catch(() => {});
        }}
        accessibilityRole="button"
        accessibilityLiveRegion={current.tone === 'warn' ? 'assertive' : 'polite'}
        accessibilityLabel={`${current.title}. ${current.body}`}
        accessibilityHint="Opens it"
        style={({ pressed }) => [st.card, pressed && { backgroundColor: C.wash }]}>
        <View style={[st.accent, { backgroundColor: look.accent }]} />
        <View style={[st.icon, { backgroundColor: look.tint }]}>
          <Icon name={look.icon} size={16} color={look.accent} strokeWidth={2.4} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]}>
            {current.title}
          </Text>
          {current.body ? (
            <Text numberOfLines={2} style={{ fontSize: 14, lineHeight: 19, color: C.body, marginTop: 1 }}>
              {current.body}
            </Text>
          ) : null}
        </View>
        {more > 0 ? (
          <View style={st.more}>
            <Text style={[{ fontSize: 12, color: C.primaryDeep }, weight(600)]}>{'+' + more}</Text>
          </View>
        ) : null}
      </Pressable>
      <View style={st.grabber} />
    </Animated.View>
  );
}

const st = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 10,
    right: 10,
    zIndex: 100,
    elevation: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.hairline,
    paddingLeft: 18,
    paddingRight: 12,
    paddingVertical: 12,
    minHeight: 64,
    overflow: 'hidden',
    boxShadow: '0 14px 32px -12px rgba(22,22,22,0.32), 0 2px 8px rgba(22,22,22,0.08)',
  },
  accent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  more: {
    minWidth: 30,
    height: 24,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: C.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* Says it can be pushed back up — the way it came. */
  grabber: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    marginTop: 6,
    backgroundColor: 'rgba(22,22,22,0.18)',
  },
});
