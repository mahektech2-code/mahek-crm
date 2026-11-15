import React from 'react';
import { Animated, View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { color as C, radius, weight } from '../../theme/tokens';
import { BADGE_FONT_CAP, BAR_FONT_CAP } from '../ui/font-scale';
import { Icon, type IconName } from '../ui/Icon';
import { Pop, usePressScale, useShake } from '../ui/motion';
import { feedback } from '../ui/feedback';

/**
 * The frame every in-app screen sits inside, as Version 3 draws it: a HERO
 * BLOCK at the top — navy on the day screens, lavender everywhere else, its
 * bottom corners rounded — carrying the status chips, refresh, the bell, the
 * back button and the screen's title; and a FLOATING navy pill at the bottom
 * with Today · Book · Me and the round + beside it.
 *
 * These take callbacks rather than reaching for the router themselves, so the
 * whole frame can be rendered and looked at without a navigator around it.
 */

export type HeroTone = 'navy' | 'lavender';

/** What each tone paints, so no screen picks a colour the hero did not. */
export const HERO = {
  navy: {
    bg: C.navy,
    ink: C.onNavy,
    muted: C.onNavyMuted,
    button: C.navySoft,
    buttonInk: C.onNavy,
  },
  lavender: {
    bg: C.lavender,
    ink: C.lavenderInk,
    muted: C.lavenderMuted,
    button: C.surface,
    buttonInk: C.lavenderInk,
  },
} as const;

/* ------------------------------------------------------------ status chips */

export type StripTone = 'ok' | 'warn' | 'idle';

export type StatusChip = {
  key: string;
  /** Read out, and shown beside the icon when `text` is given. */
  label: string;
  /** Drawn beside the icon. Absent draws the icon alone, as the GPS chip does. */
  text?: string;
  icon: IconName;
  tone: StripTone;
  onPress: () => void;
};

/**
 * The three facts the salesman should never have to go looking for — whether
 * the day is started, whether the phone knows where it is, and how much work
 * is still on the handset unsent — as round chips in the hero rather than a
 * strip of words under it. Each still opens the screen that explains it,
 * because a light you cannot act on is decoration.
 */
function Chip({ chip, tone }: { chip: StatusChip; tone: HeroTone }) {
  const fg =
    tone === 'navy'
      ? chip.tone === 'ok'
        ? C.lime
        : chip.tone === 'warn'
          ? '#FFC44D'
          : C.onNavyMuted
      : chip.tone === 'ok'
        ? C.success
        : chip.tone === 'warn'
          ? C.warnInk
          : C.muted;
  const bg =
    tone === 'navy'
      ? chip.tone === 'ok'
        ? C.limeOnNavy
        : chip.tone === 'warn'
          ? 'rgba(255,196,77,0.16)'
          : C.navySoft
      : C.surface;
  return (
    <Pressable
      onPress={chip.onPress}
      /* 32pt of chip against a 48pt floor. The touch area is bought back
         vertically rather than with pixels the hero does not have. */
      hitSlop={{ top: 8, bottom: 8 }}
      accessibilityRole="button"
      accessibilityLabel={chip.label}
      style={[s.chip, { backgroundColor: bg }, chip.text ? { paddingHorizontal: 10 } : { width: 32 }]}>
      <Pop trigger={chip.tone} from={0.6}>
        <Icon name={chip.icon} size={chip.text ? 14 : 16} color={fg} strokeWidth={2.2} />
      </Pop>
      {chip.text ? (
        <Text numberOfLines={1} maxFontSizeMultiplier={BAR_FONT_CAP} style={[{ fontSize: 13, color: fg }, weight(700)]}>
          {chip.text}
        </Text>
      ) : null}
    </Pressable>
  );
}

/* ----------------------------------------------------------------- header */

/**
 * The hero block. It sits at the top of the scroll and travels with it, the
 * way the design draws it, so a long list gets the whole screen once he has
 * started reading.
 */
export function Header({
  title,
  tone = 'lavender',
  showTitle = true,
  onBack,
  backLabel,
  onBell,
  unread,
  onRefresh,
  refreshing = false,
  unreadLoaded = true,
  chips,
  actions,
  overlap = false,
  children,
}: {
  title: string;
  tone?: HeroTone;
  /** Off where the screen's own hero content names the screen. */
  showTitle?: boolean;
  onBack?: () => void;
  backLabel?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  onBell?: () => void;
  unread: number;
  unreadLoaded?: boolean;
  chips: StatusChip[];
  /** Extra round buttons after the bell — a screen's own ⋯ menu. */
  actions?: React.ReactNode;
  /** Leaves room under the block for the first card to sit across its edge. */
  overlap?: boolean;
  children?: React.ReactNode;
}) {
  const h = HERO[tone];
  return (
    <View style={[s.hero, { backgroundColor: h.bg, paddingBottom: overlap ? 46 : 20 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={backLabel ? `Back to ${backLabel}` : 'Back'}
            hitSlop={4}
            style={[s.round40, { backgroundColor: tone === 'navy' ? C.navySoft : C.surface }]}>
            <Icon name="back" size={20} color={h.buttonInk} strokeWidth={2} />
          </Pressable>
        ) : null}
        {chips.map((c) => (
          <Chip key={c.key} chip={c} tone={tone} />
        ))}
        <View style={{ flex: 1 }} />
        {onRefresh ? (
          <Pressable
            onPress={refreshing ? undefined : onRefresh}
            accessibilityRole="button"
            accessibilityLabel="Refresh"
            accessibilityHint="Sends your work, gets the latest from the office, and checks for a new version"
            accessibilityState={{ busy: refreshing }}
            hitSlop={4}
            style={[s.round36, { backgroundColor: h.button }]}>
            {refreshing ? (
              <ActivityIndicator size="small" color={h.buttonInk} />
            ) : (
              <Icon name="refresh" size={18} color={h.buttonInk} strokeWidth={2} />
            )}
          </Pressable>
        ) : null}
        {/* A bell whose whole job is to bring you to the notifications screen
            is furniture once you are standing on it — and tapping it pushed a
            second copy of the page. */}
        {onBell ? <Bell onPress={onBell} unread={unread} loaded={unreadLoaded} tone={tone} /> : null}
        {actions}
      </View>
      {showTitle ? (
        <Text
          numberOfLines={2}
          maxFontSizeMultiplier={BAR_FONT_CAP}
          accessibilityRole="header"
          style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: h.ink, marginTop: 16 }, weight(800)]}>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** A round button in the hero, for a screen's own action (the ⋯ menu). */
export function HeroButton({
  icon,
  label,
  onPress,
  tone = 'lavender',
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: HeroTone;
}) {
  const h = HERO[tone];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[s.round36, { backgroundColor: h.button }]}>
      <Icon name={icon} size={18} color={h.buttonInk} strokeWidth={2} />
    </Pressable>
  );
}

/**
 * "Rose" is measured against this bell's own last count. Every screen draws
 * its own header, so a fresh screen remembers the count from the module, or
 * every navigation would ring the bell for messages already rung for.
 */
let lastSeenUnread = 0;

function Bell({
  onPress,
  unread,
  loaded,
  tone,
}: {
  onPress: () => void;
  unread: number;
  loaded: boolean;
  tone: HeroTone;
}) {
  const h = HERO[tone];
  const ring = useShake(null);
  const shake = ring.shake;
  /* Each bell keeps its OWN last count, seeded from the last one any bell saw.
     Every screen in the stack polls, and a hidden screen updating one shared
     number first would leave the visible bell thinking nothing had risen. */
  const [seenAtMount] = React.useState(lastSeenUnread);
  const seen = React.useRef(seenAtMount);
  /* Before the first read the count is a placeholder 0, not a fall to zero. */
  React.useEffect(() => {
    if (!loaded) return;
    if (unread > seen.current) shake();
    seen.current = unread;
    lastSeenUnread = unread;
  }, [unread, shake, loaded]);
  const rose = loaded && unread > seenAtMount;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      hitSlop={4}
      style={[s.round36, { backgroundColor: h.button }]}>
      <Animated.View
        style={{
          transform: [
            { translateX: ring.style.transform[0].translateX },
            { rotate: ring.style.transform[0].translateX.interpolate({ inputRange: [-4, 4], outputRange: ['-12deg', '12deg'] }) },
          ],
        }}>
        <Icon name="bell" size={18} color={h.buttonInk} strokeWidth={2} />
      </Animated.View>
      {unread > 0 ? (
        <Pop trigger={unread} popOnMount={rose} style={s.bellBadge}>
          <Text
            maxFontSizeMultiplier={BADGE_FONT_CAP}
            style={[{ color: '#fff', fontSize: 10, lineHeight: 16, textAlign: 'center' }, weight(700)]}>
            {unread > 99 ? '99+' : unread}
          </Text>
        </Pop>
      ) : null}
    </Pressable>
  );
}

/* --------------------------------------------------------------- tab bar */

/**
 * The bar's own height. The floating pill sits `TAB_BAR_GAP` above the safe
 * area, so anything that has to clear it — the toast, a screen's last row —
 * clears `TAB_BAR_HEIGHT + TAB_BAR_GAP`.
 */
export const TAB_BAR_HEIGHT = 64;
export const TAB_BAR_GAP = 18;

/**
 * The four roots the app has always had. Version 3 draws three places — Today,
 * Book, Me — and the day's route is part of Today, so `journey` lights Today.
 */
export type TabKey = 'home' | 'journey' | 'customers' | 'more';

type Place = { k: 'today' | 'book' | 'me'; label: string; ic: IconName; to: TabKey; lights: TabKey[] };

const PLACES: Place[] = [
  { k: 'today', label: 'Today', ic: 'clock', to: 'home', lights: ['home', 'journey'] },
  { k: 'book', label: 'Book', ic: 'map', to: 'customers', lights: ['customers'] },
  { k: 'me', label: 'Me', ic: 'person', to: 'more', lights: ['more'] },
];

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
   * A count to draw on a place, by the tab it stands for. Absent or zero draws
   * nothing. Only counts that GO AWAY when they are dealt with belong here — a
   * pip that is lit all day is one nobody sees. Journey's count lands on Today.
   */
  badges?: Partial<Record<TabKey, number>>;
  onAction?: () => void;
}) {
  const countFor = (p: Place) => p.lights.reduce((n, k) => n + (badges?.[k] ?? 0), 0);
  return (
    <View pointerEvents="box-none" style={[s.barWrap, { bottom: bottomInset + TAB_BAR_GAP }]}>
      <View style={s.pill}>
        {PLACES.map((p) => {
          const on = active != null && p.lights.includes(active);
          const count = countFor(p);
          return (
            <Pressable
              key={p.k}
              onPress={() => {
                if (!on || active !== p.to) feedback('select');
                onTab(p.to);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={count > 0 ? `${p.label}, ${count} waiting` : p.label}
              style={[s.place, on && s.placeOn]}>
              <View>
                <Icon name={p.ic} size={on ? 20 : 22} color={on ? C.lime : C.onNavyMuted} strokeWidth={2} />
                {count > 0 ? (
                  <Pop trigger={count} style={s.tabBadge}>
                    <Text
                      maxFontSizeMultiplier={BADGE_FONT_CAP}
                      style={[{ color: '#fff', fontSize: 10, lineHeight: 16, textAlign: 'center' }, weight(700)]}>
                      {count > 9 ? '9+' : count}
                    </Text>
                  </Pop>
                ) : null}
              </View>
              {on ? (
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={BAR_FONT_CAP}
                  style={[{ fontSize: 13, color: C.lime }, weight(700)]}>
                  {p.label}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * The round + beside the pill: the entry point to every quick action. A
 * sibling of the bar rather than a child of it, positioned against the frame,
 * so nothing about the bar's own clipping can make it go dead.
 */
export function TabBarAction({ onPress, bottomInset }: { onPress: () => void; bottomInset: number }) {
  const press = usePressScale(0.92);
  return (
    <Animated.View style={[s.fab, { bottom: bottomInset + TAB_BAR_GAP }, press.style]}>
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel="Quick actions"
        accessibilityHint="What are you doing? Start a visit, take an order, collect a payment and more"
        style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="add" size={28} color="#FFFFFF" strokeWidth={2.2} />
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  hero: {
    paddingTop: 14,
    paddingHorizontal: 20,
    borderBottomLeftRadius: radius.hero,
    borderBottomRightRadius: radius.hero,
  },
  chip: {
    height: 32,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  round36: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  round40: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  bellBadge: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#FF6B5E',
  },
  barWrap: { position: 'absolute', left: 16, right: 16 + 64 + 10 },
  pill: {
    height: TAB_BAR_HEIGHT,
    borderRadius: 32,
    backgroundColor: C.navy,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    boxShadow: '0 12px 30px -10px rgba(15,27,51,0.5)',
  },
  place: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  placeOn: { flex: 1.4, backgroundColor: C.limeOnNavy },
  tabBadge: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: C.primary,
  },
  fab: {
    position: 'absolute',
    right: 16,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 12px 28px -8px rgba(104,53,251,0.6)',
  },
});
