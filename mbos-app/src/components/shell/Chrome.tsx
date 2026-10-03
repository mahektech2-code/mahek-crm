import React from 'react';
import { Animated, View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { color as C, HIT, shadow, weight } from '../../theme/tokens';
import { Icon } from '../ui/Icon';
import { EASE, Pop, usePressScale, useReduceMotion, useShake } from '../ui/motion';
import { feedback } from '../ui/feedback';

/**
 * The frame every in-app screen sits inside: a 52px title bar, the status
 * strip under it, and the tab bar with its raised action button.
 *
 * These take callbacks rather than reaching for the router themselves, so the
 * whole frame can be rendered and looked at without a navigator around it.
 */

/* ----------------------------------------------------------------- header */

export function Header({
  title,
  onBack,
  onBell,
  unread,
  onRefresh,
  refreshing = false,
  unreadLoaded = true,
}: {
  title: string;
  onBack?: () => void;
  /**
   * Send, pull, and look for a new version — see `native/refresh.ts`. On every
   * screen, because the moment somebody wonders whether his phone has the
   * office's latest is never on the Sync screen.
   */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Absent on the notifications screen itself — see `AppFrame`. */
  onBell?: () => void;
  unread: number;
  /** False until the count has been read once — see `Bell`. */
  unreadLoaded?: boolean;
}) {
  return (
    <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 }}>
      {onBack ? (
        <Pressable onPress={onBack} accessibilityLabel="Back" style={[s.iconBtn, { marginLeft: -12 }]}>
          <Icon name="back" size={24} color={C.body} strokeWidth={1.5} />
        </Pressable>
      ) : null}
      <Text numberOfLines={1} style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }, weight(600)]}>
        {title}
      </Text>
      {onRefresh ? (
        <Pressable
          onPress={refreshing ? undefined : onRefresh}
          accessibilityLabel="Refresh"
          accessibilityHint="Sends your work, gets the latest from the office, and checks for a new version"
          accessibilityState={{ busy: refreshing }}
          style={[s.iconBtn, { marginRight: -12 }]}>
          {refreshing ? (
            <ActivityIndicator size="small" color={C.body} />
          ) : (
            <Icon name="refresh" size={22} color={C.body} strokeWidth={1.5} />
          )}
        </Pressable>
      ) : null}
      {/* A bell whose whole job is to bring you to the notifications screen is
          furniture once you are standing on it — and tapping it pushed a second
          copy of the page. The space is held rather than collapsed, so the title
          does not jump sideways as you arrive. */}
      {onBell ? (
        <Bell onPress={onBell} unread={unread} loaded={unreadLoaded} />
      ) : (
        <View style={s.iconBtn} />
      )}
    </View>
  );
}

/**
 * The bell, which says when something NEW has arrived rather than only how
 * many things are waiting.
 *
 * A count that goes from 2 to 3 in place is a digit changing in a corner, and
 * nobody sees it. So a RISE rings the bell — one short shake — and pops the
 * badge; a fall (somebody read one) moves nothing, because reading a message
 * is not news. The shake carries no buzz of its own: the push banner that
 * usually accompanies a rise has already buzzed, and two buzzes for one
 * message is a stutter.
 *
 * "Rose" is measured against this bell's own last count. Every screen draws
 * its own header, so a fresh screen remembers the count from the module, or
 * every navigation would ring the bell for messages already rung for.
 */
let lastSeenUnread = 0;

function Bell({ onPress, unread, loaded }: { onPress: () => void; unread: number; loaded: boolean }) {
  const ring = useShake(null);
  const shake = ring.shake;
  /* Before the first read the count is a placeholder 0, not a fall to zero. */
  const rose = loaded && unread > lastSeenUnread;
  React.useEffect(() => {
    if (!loaded) return;
    if (rose) shake();
    lastSeenUnread = unread;
  }, [unread, rose, shake, loaded]);

  return (
    <Pressable onPress={onPress} accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'} style={s.iconBtn}>
      <Animated.View
        style={{
          transform: [
            { translateX: ring.style.transform[0].translateX },
            { rotate: ring.style.transform[0].translateX.interpolate({ inputRange: [-4, 4], outputRange: ['-12deg', '12deg'] }) },
          ],
        }}>
        <Icon name="bell" size={24} color={C.body} strokeWidth={1.5} />
      </Animated.View>
      {unread > 0 ? (
        <Pop trigger={unread} popOnMount={rose} style={s.bellBadge}>
          <Text style={[{ color: '#fff', fontSize: 12, lineHeight: 18, textAlign: 'center' }, weight(500)]}>{unread}</Text>
        </Pop>
      ) : null}
    </Pressable>
  );
}

/* ------------------------------------------------------------ status strip */

export type StripTone = 'ok' | 'warn' | 'idle';

/**
 * Three facts the salesman should never have to go looking for: whether the
 * day is started, whether the phone knows where it is, and how much work is
 * still sitting on the handset unsent. Each one opens the screen that explains
 * it, because a light you cannot act on is decoration.
 */
export function StatusStrip({
  items,
}: {
  items: { key: string; label: string; tone: StripTone; onPress: () => void }[];
}) {
  return (
    <View style={s.strip}>
      {items.map((it, i) => (
        <Pressable
          key={it.key}
          onPress={it.onPress}
          /* 28pt of cell against a 48pt floor, on the one control that is on
             all forty screens — so the miss was repeated everywhere. The strip
             cannot be made taller without moving every screen down, so the
             touch area is bought back rather than the pixels. Vertical only:
             the three cells are adjacent, and horizontal slop would make each
             one steal its neighbour's edge. */
          hitSlop={{ top: 10, bottom: 10 }}
          style={[s.stripCell, i > 0 && { borderLeftWidth: 1, borderLeftColor: C.border }]}>
          {/* The light pops when it CHANGES — "GPS locked" arriving, the last
              thing sent — so a state the salesman was waiting on is seen to
              arrive rather than found later. */}
          <Pop
            trigger={it.tone}
            from={0.2}
            style={{
              width: 7,
              height: 7,
              borderRadius: 3.5,
              backgroundColor: it.tone === 'ok' ? C.success : it.tone === 'warn' ? C.warn : C.faint,
            }}>
            {null}
          </Pop>
          <Text numberOfLines={1} style={[{ fontSize: 12, color: C.body }, weight(500)]}>
            {it.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/* --------------------------------------------------------------- tab bar */

/**
 * The bar's own height, above the safe-area inset.
 *
 * Exported because the toast has to clear it and was guessing: `bottom: 88`
 * happened to equal `64 + a 24pt gesture bar` on one handset and sat on top of
 * the bar on every other. One number, read by the two things whose job is not
 * to overlap.
 */
export const TAB_BAR_HEIGHT = 64;
const INDICATOR_WIDTH = 28;

export type TabKey = 'home' | 'journey' | 'customers' | 'more';

const TABS: { k: TabKey; label: string; ic: string }[] = [
  { k: 'home', label: 'Home', ic: 'home' },
  { k: 'journey', label: 'Journey', ic: 'route' },
  { k: 'customers', label: 'Customers', ic: 'people' },
  { k: 'more', label: 'More', ic: 'grid' },
];

/**
 * Where the tab indicator last stood, in points from the bar's left edge.
 *
 * Every tab root is its own screen with its own `TabBar`, swapped in by
 * `router.replace` — so there is no ONE bar for an indicator to slide along.
 * The new bar starts its indicator where the old one left it and slides it
 * home, which is the same picture: the line travels from the tab you left to
 * the tab you chose.
 */
let lastIndicatorX: number | null = null;

export function TabBar({
  active,
  onTab,
  bottomInset,
  badges,
}: {
  active: TabKey | null;
  onTab: (k: TabKey) => void;
  bottomInset: number;
  /**
   * A count to draw on a tab, by key. Absent or zero draws nothing.
   *
   * A tab bar is on every screen of the app, which is what makes it the only
   * place a question can be put in front of somebody who is not looking for
   * it. That is also why the bar must stay quiet: a pip that is lit all day is
   * one nobody sees. Only counts that GO AWAY when they are dealt with belong
   * here.
   */
  badges?: Partial<Record<TabKey, number>>;
}) {
  const reduce = useReduceMotion();
  const x = React.useRef(new Animated.Value(lastIndicatorX ?? -100)).current;
  const [centres, setCentres] = React.useState<Partial<Record<TabKey, number>>>({});
  const target = active ? centres[active] : undefined;

  React.useEffect(() => {
    if (target == null) return;
    const to = target - INDICATOR_WIDTH / 2;
    const from = lastIndicatorX;
    lastIndicatorX = to;
    if (reduce || from == null || from === to) {
      x.setValue(to);
      return;
    }
    x.setValue(from);
    const a = Animated.timing(x, { toValue: to, duration: 260, easing: EASE, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [target, reduce, x]);

  const measure = (k: TabKey) => (e: { nativeEvent: { layout: { x: number; width: number } } }) => {
    const { x: left, width } = e.nativeEvent.layout;
    const c = left + width / 2;
    setCentres((prev) => (prev[k] === c ? prev : { ...prev, [k]: c }));
  };

  const choose = (k: TabKey) => {
    if (k !== active) feedback('select');
    onTab(k);
  };

  return (
    <View style={[s.tabBar, { height: TAB_BAR_HEIGHT + bottomInset, paddingBottom: bottomInset }]}>
      {/* The line over the tab you are on. Off the bar entirely on screens
          that are not a tab root, where no tab is "on". */}
      {active && target != null ? (
        <Animated.View pointerEvents="none" style={[s.indicator, { transform: [{ translateX: x }] }]} />
      ) : null}
      {TABS.slice(0, 2).map((t) => (
        <Tab key={t.k} tab={t} on={active === t.k} count={badges?.[t.k] ?? 0} onPress={() => choose(t.k)} onLayout={measure(t.k)} />
      ))}
      {/* The gap the raised button sits in — it is drawn BESIDE this bar
          rather than inside it, see `TabBarAction`. */}
      <View style={{ flex: 1 }} />
      {TABS.slice(2).map((t) => (
        <Tab key={t.k} tab={t} on={active === t.k} count={badges?.[t.k] ?? 0} onPress={() => choose(t.k)} onLayout={measure(t.k)} />
      ))}
    </View>
  );
}

/**
 * The raised `+`, and why it is not a child of the bar it sits on.
 *
 * `bottom: TAB_BAR_HEIGHT + bottomInset - 52 + 20` inside a container of height
 * `TAB_BAR_HEIGHT + bottomInset` puts the 52pt circle's top edge at y = −20
 * relative to that container — the gesture inset cancels out, so the top 20pt
 * of the button hangs outside its own parent on every handset.
 *
 * It is still DRAWN there, and on this renderer it is still touchable: React
 * Native leaves `clipChildren` off, and Fabric measures how far a child
 * overflows its parent and widens the parent's hit test by exactly that much.
 * But that is a lot of machinery holding up the entry point to every quick
 * action in the app — one `overflow: 'hidden'` on the bar, or a build that is
 * not on the new renderer, and the visually obvious top of the button goes
 * inert with nothing to see. A dead button reads as a frozen app, not as a
 * missed target.
 *
 * So it is a SIBLING of the bar, positioned against the frame, which is tall
 * enough to contain it. The arithmetic is deliberately unchanged and lands on
 * the same pixel: an absolutely positioned child is measured from its
 * containing block's border box — padding is not subtracted — and the frame's
 * bottom edge is the bar's bottom edge.
 */
export function TabBarAction({ onPress, bottomInset }: { onPress: () => void; bottomInset: number }) {
  /* The most-pressed control in the app, and it gave nothing back. It sinks
     a little under the thumb like every other button now. */
  const press = usePressScale(0.92);
  return (
    <Animated.View style={[s.fab, { bottom: TAB_BAR_HEIGHT + bottomInset - 52 + 20 }, press.style]}>
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityLabel="What are you doing?"
        style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: C.lime, fontSize: 26, lineHeight: 30 }}>+</Text>
      </Pressable>
    </Animated.View>
  );
}

function Tab({
  tab,
  on,
  count,
  onPress,
  onLayout,
}: {
  tab: { k: TabKey; label: string; ic: string };
  on: boolean;
  count: number;
  onPress: () => void;
  onLayout?: (e: { nativeEvent: { layout: { x: number; width: number } } }) => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLayout={onLayout}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      /* The count is read out as part of the tab rather than left as a
         decoration a screen reader skips — it is the whole reason to press. */
      accessibilityLabel={count > 0 ? `${tab.label}, ${count} waiting` : tab.label}
      style={{ flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      <View style={{ height: 22, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={tab.ic} size={22} color={on ? C.primary : C.muted} />
        {count > 0 ? (
          <Pop trigger={count} style={s.tabBadge}>
            <Text style={[{ color: '#fff', fontSize: 11, lineHeight: 16, textAlign: 'center' }, weight(500)]}>
              {count > 9 ? '9+' : count}
            </Text>
          </Pop>
        ) : null}
      </View>
      <Text style={[{ fontSize: 12, color: on ? C.primary : C.muted }, weight(on ? 500 : 400)]}>{tab.label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  iconBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  /* Hung off the icon's top-right, like the bell's. Smaller, because it sits
     in a 22pt row rather than a 48pt button and a badge that pushes the label
     down would move the whole bar. */
  tabBadge: {
    position: 'absolute',
    top: -5,
    left: 12,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: C.danger,
  },
  bellBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: C.danger,
  },
  strip: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: C.hairline,
    backgroundColor: C.wash,
  },
  stripCell: {
    flex: 1,
    minWidth: 0,
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  indicator: {
    position: 'absolute',
    top: -1,
    left: 0,
    width: INDICATOR_WIDTH,
    height: 3,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: C.primary,
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderTopWidth: 1,
    borderTopColor: C.hairline,
    boxShadow: shadow.tabBar,
  },
  fab: {
    position: 'absolute',
    left: '50%',
    marginLeft: -28,
    width: 56,
    height: 52,
    borderRadius: 28,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: shadow.fab,
  },
});
