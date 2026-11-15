import React from 'react';
import { Animated, Text, View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { Pill } from '../src/components/ui/v3';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { color as C, tabular, weight } from '../src/theme/tokens';
import { dmy, plural } from '../src/lib/format';
import { listNotifications, markAllRead, markRead, type Notification } from '../src/data/notifications';
import { DUR, EASE, Stagger, animateLayoutFor, useReduceMotion } from '../src/components/ui/motion';

/**
 * The bell.
 *
 * Opening a row marks it read, because having read it is exactly what tapping
 * it means. A row that names a screen on this phone opens it; one that names
 * none — or names an office screen, which does not exist here — is read where
 * it is, and says everything it has to say in its body.
 */

/* The screens a row may open. The office stores its own web links on the
   same rows, and pushing `/crm/performance` here lands on the router's
   "Unmatched Route" page — so anything not on this list is not followed. */
const SCREENS = new Set([
  'home', 'customers', 'customer', 'account', 'accounts', 'journey', 'pick', 'tasks', 'leads', 'lead',
  'samples', 'sample', 'orders', 'collections', 'expenses', 'travel', 'leave', 'attendance', 'performance',
  'salary', 'docs', 'sync', 'rejections', 'notifications', 'nearby', 'maps', 'profile', 'policy',
  'reports', 'more', 'validate',
]);

function phoneRoute(href: string | null): string | null {
  if (!href || !href.startsWith('/')) return null;
  const first = href.slice(1).split(/[/?]/)[0];
  return SCREENS.has(first) ? href : null;
}

/* `fg` is the unread pip, `ink` the mark and the chip's words. */
const TONE: Record<Notification['kind'], { bg: string; fg: string; ink: string }> = {
  danger: { bg: C.dangerBg, fg: C.danger, ink: C.danger },
  amber: { bg: C.warnBg, fg: C.warn, ink: C.warnInk },
  success: { bg: C.successBg, fg: C.success, ink: C.success },
  neutral: { bg: C.primaryTint, fg: C.primaryDeep, ink: C.primaryDeep },
};

const WHENS: ('Today' | 'Yesterday' | 'Earlier')[] = ['Today', 'Yesterday', 'Earlier'];

/**
 * What the chip on a row says, keyed on where the row goes.
 *
 * A notification whose destination has no agreed wording gets no chip rather
 * than an invented verb — the point of the chip is that it names the next act,
 * and "Open" names nothing.
 */
const CTA: Record<string, string> = {
  '/tasks': 'Open tasks',
  '/journey': 'See the route',
  '/expenses': 'Open expenses',
  '/leave': 'Open leave',
  '/docs': 'Open documents',
  '/sync': 'Waiting to send',
  '/rejections': 'Not accepted',
};

function bucketOf(createdAt: number, today: string, yesterday: string): 'Today' | 'Yesterday' | 'Earlier' {
  if (!Number.isFinite(createdAt)) return 'Earlier';
  const day = istDay(createdAt);
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : 'Earlier';
}

/* India's clock by name, like every other screen that turns a stored instant
   into a time — the phone's own zone is whatever it happens to be set to. And
   the same 24-hour form as the rest of the app. */
const IST_TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const IST_DAY = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata' });

function istDay(ms: number): string {
  return IST_DAY.format(new Date(ms));
}

/** 08:40 for the last two days; the date itself for anything older. */
function stamp(createdAt: number, bucket: string): string {
  if (!Number.isFinite(createdAt)) return '';
  if (bucket === 'Earlier') return dmy(istDay(createdAt));
  return IST_TIME.format(new Date(createdAt));
}

/**
 * The unread dot, which LEAVES rather than vanishes.
 *
 * Reading a notification is the one change this screen makes, and the dot is
 * the whole of how it shows: blinking out in a frame reads as a redraw, while
 * shrinking away reads as "that one is dealt with". Version 3 draws it as the
 * pip on the row's round mark, so it never moves the row's text either.
 */
function UnreadDot({ unread, tint }: { unread: boolean; tint: string }) {
  const reduce = useReduceMotion();
  const v = React.useRef(new Animated.Value(unread ? 1 : 0)).current;
  React.useEffect(() => {
    if (reduce) {
      v.setValue(unread ? 1 : 0);
      return;
    }
    const anim = Animated.timing(v, {
      toValue: unread ? 1 : 0,
      duration: DUR.settle,
      easing: EASE,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [unread, reduce, v]);
  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 10,
        height: 10,
        borderRadius: 5,
        borderWidth: 2,
        borderColor: '#FFFFFF',
        backgroundColor: tint,
        opacity: v,
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) }],
      }}
    />
  );
}

export default function NotificationsScreen() {
  const back = useCameFrom('home');
  const [rows, setRows] = React.useState<Notification[]>([]);
  const [days] = React.useState(() => ({
    today: istDay(Date.now()),
    yesterday: istDay(Date.now() - 86_400_000),
  }));

  /* Whether the read has answered yet, kept apart from what it answered. Drawn
     without it, "Nothing yet" is on screen for as long as SQLite takes — and a
     definitive sentence that turns out to be wrong is worse than a moment of
     saying nothing. A failure clears it rather than leaving a screen that says
     "Reading…" for ever. */
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  /* `animate` only after a mark-read: the rows' weight and tint change, the
     "Mark all read" link goes, and the header line rewrites. Opening the screen
     is not a change and does not ask. */
  const load = React.useCallback((animate?: boolean) => {
    let live = true;
    void listNotifications()
      .then((r) => {
        if (!live) return;
        if (animate === true) animateLayoutFor(r.length);
        setRows(r);
        setFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        if (!live) return;
        setFailed(true);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(React.useCallback(() => load(), [load]));

  const unread = rows.filter((n) => n.readAt == null).length;

  const subtitle = !loaded
    ? 'Reading…'
    : unread
      ? plural(unread, 'unread notification')
      : rows.length > 0
        ? plural(rows.length, 'notification') + ', all read'
        : 'Nothing yet';

  return (
    <AppFrame
      title="Notifications"
      activeTab={null}
      onBack={back.go}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: 24 }}
      heroActions={
        unread > 0 ? (
          <Pressable
            onPress={async () => {
              await markAllRead();
              load(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Mark all read"
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => ({
              height: 40,
              paddingHorizontal: 14,
              borderRadius: 20,
              backgroundColor: C.navy,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              opacity: pressed ? 0.85 : 1,
            })}>
            <Glyph shapes={[{ p: 'M3 12l5 5 9-10M12 17l1 1 9-10' }]} size={16} color={C.lime} strokeWidth={2.4} />
            <Text style={[{ fontSize: 13, color: '#FFFFFF' }, weight(700)]}>All read</Text>
          </Pressable>
        ) : null
      }
      hero={
        /* "Nothing unread" was shown both to somebody who has never had a
           notification and to somebody who has read forty, so the two were
           indistinguishable — and under a heading with nothing beneath it,
           the first case read as a screen that had failed to load. */
        <T style={{ fontSize: 12, color: C.lavenderMuted, marginTop: 4 }}>{subtitle}</T>
      }>
      <BackLink label={back.label} onPress={back.go} />

      {/* Every group returns null when there is nothing in it, so with no rows
          at all what was left was a back link, a heading and white space — on
          the app's own bell, which is a screen somebody taps again, and again,
          believing it did not load. It says what will arrive here instead. */}
      {loaded && !failed && rows.length === 0 ? (
        <View
          accessible
          accessibilityLabel="Nothing yet. Messages from the office show here. For example, an order not accepted, a day plan to agree, or a new task."
          style={{ marginTop: 26, backgroundColor: C.surface, borderRadius: 24, paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center' }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.lavender, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="bell" size={28} color={C.primary} strokeWidth={2} />
          </View>
          <Text style={[{ fontSize: 18, color: C.ink, marginTop: 12 }, weight(800)]}>Nothing yet</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 12 }}>
            <Pill text="Order not accepted" bg={C.dangerBg} fg={C.danger} />
            <Pill text="Day to agree" bg={C.warnBg} fg={C.warnInk} />
            <Pill text="New task" bg={C.primaryTint} fg={C.primaryDeep} />
          </View>
          <T style={{ fontSize: 13, color: C.muted, marginTop: 10, textAlign: 'center' }}>Messages from the office show here.</T>
        </View>
      ) : null}

      {loaded && failed ? (
        <View
          accessible
          accessibilityLabel="Could not read your notifications. Nothing is lost. They are still on this phone. Go back and open this screen again."
          style={{ marginTop: 20, backgroundColor: C.dangerBg, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 10 }}>
          <Icon name="warn" size={20} color={C.danger} strokeWidth={2} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 14, color: C.danger }, weight(700)]}>Could not read your notifications</Text>
            <T style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Nothing is lost — still on this phone. Go back and open again.</T>
          </View>
        </View>
      ) : null}

      {WHENS.map((g) => {
        const items = rows.filter((n) => bucketOf(n.createdAt, days.today, days.yesterday) === g);
        if (items.length === 0) return null;
        /* Today is the white card; the settled days sit on the read tint. */
        const settled = g !== 'Today';
        return (
          <View key={g} style={{ marginTop: 18 }}>
            <Text accessibilityRole="header" style={[{ fontSize: 15, color: settled ? C.muted : C.ink, paddingHorizontal: 6 }, weight(700)]}>
              {g}
            </Text>
            <View style={{ marginTop: 8, backgroundColor: settled ? '#F6F8FB' : C.surface, borderRadius: 20, paddingHorizontal: 14, overflow: 'hidden' }}>
              {items.map((n, i) => {
                const isUnread = n.readAt == null;
                const tone = TONE[n.kind] ?? TONE.neutral;
                const href = phoneRoute(n.href);
                const base = href ? href.split('?')[0] : null;
                const cta = base ? CTA[base] : undefined;
                return (
                  <Stagger key={n.id} index={rows.indexOf(n)}>
                    <Pressable
                      onPress={async () => {
                        await markRead(n.id);
                        load();
                        /* Reading is not acknowledging — a priority notification
                           is cleared by the screen that fixes the problem, never
                           by this one. */
                        if (href) router.push(`${href}${href.includes('?') ? '&' : '?'}from=notifications`);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${isUnread ? 'Unread. ' : ''}${n.title}. ${n.body}${cta ? '. ' + cta : ''}`}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        gap: 12,
                        paddingVertical: 14,
                        borderTopWidth: i ? 1 : 0,
                        borderTopColor: C.hairline,
                        opacity: pressed ? 0.8 : 1,
                      })}>
                      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tone.bg, alignItems: 'center', justifyContent: 'center' }}>
                        <Glyph shapes={glyphFor(base)} size={18} color={tone.ink} />
                        <UnreadDot unread={isUnread} tint={tone.fg} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                          <Text style={[{ flex: 1, minWidth: 0, fontSize: 15, color: isUnread ? C.ink : C.body }, weight(isUnread ? 800 : 600)]}>
                            {n.title}
                          </Text>
                          <Text style={[{ fontSize: 12, color: C.faint }, tabular]}>{stamp(n.createdAt, g)}</Text>
                        </View>
                        <T style={{ fontSize: 13, color: isUnread ? C.body : C.muted, marginTop: 2 }}>{n.body}</T>
                        {cta ? (
                          <View style={{ marginTop: 8, flexDirection: 'row' }}>
                            <Pill text={cta + ' →'} bg={tone.bg} fg={tone.ink} />
                          </View>
                        ) : null}
                      </View>
                    </Pressable>
                  </Stagger>
                );
              })}
            </View>
          </View>
        );
      })}
    </AppFrame>
  );
}

/**
 * The mark on a row, keyed on where the row goes — a cart for an order not
 * accepted, a route for a day to agree — and on its tone where it goes
 * nowhere on this phone. Lifted from the Version 3 artboard.
 */
const ROW_GLYPH: Record<string, GlyphShape[]> = {
  '/rejections': [{ p: 'M4 5h2l2 11h10l2-8H7' }],
  '/journey': [{ c: [6, 18, 2] }, { c: [18, 6, 2] }, { p: 'M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6' }],
  '/tasks': [{ r: [4, 4, 16, 16, 3] }, { p: 'M8 12l3 3 5-6' }],
  '/expenses': [{ p: 'M6 3h12v18l-3-2-3 2-3-2-3 2z' }],
  '/performance': [{ p: 'M3 17l6-6 4 4 8-8' }],
  '/leave': [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16' }],
  '/docs': [{ p: 'M6 3h8l4 4v14H6z' }],
  '/sync': [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }],
};
const BELL: GlyphShape[] = [{ p: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0' }];
function glyphFor(base: string | null): GlyphShape[] {
  return (base && ROW_GLYPH[base]) || BELL;
}
