import React from 'react';
import { Animated, View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, StubCard, useCameFrom } from '../src/components/shell/AppFrame';
import { ListCard, SectionLabel, T } from '../src/components/ui/primitives';
import { color as C, type, weight } from '../src/theme/tokens';
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

const TONE: Record<Notification['kind'], { bg: string; fg: string }> = {
  danger: { bg: C.dangerBg, fg: C.danger },
  amber: { bg: C.warnBg, fg: C.warn },
  success: { bg: C.successBg, fg: C.success },
  neutral: { bg: C.primaryTint, fg: C.primaryDeep },
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
 * shrinking away reads as "that one is dealt with". It keeps its 8px either
 * way, so the row's text never shifts under the thumb that just tapped it.
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
        width: 8,
        height: 8,
        borderRadius: 4,
        marginTop: 6,
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

  return (
    <AppFrame title="Notifications" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={type.h1}>Notifications</T>
          {/* "Nothing unread" was shown both to somebody who has never had a
              notification and to somebody who has read forty, so the two were
              indistinguishable — and under a heading with nothing beneath it,
              the first case read as a screen that had failed to load. */}
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {!loaded
              ? 'Reading…'
              : unread
                ? plural(unread, 'unread notification')
                : rows.length > 0
                  ? plural(rows.length, 'notification') + ', all read'
                  : 'Nothing yet'}
          </T>
        </View>
        {unread > 0 ? (
          <Pressable
            onPress={async () => {
              await markAllRead();
              load(true);
            }}
            accessibilityRole="button"
            style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 12, marginRight: -12, justifyContent: 'center' }}>
            <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Mark all read</T>
          </Pressable>
        ) : null}
      </View>

      {/* Every group returns null when there is nothing in it, so with no rows
          at all what was left was a back link, a heading and white space — on
          the app's own bell, which is a screen somebody taps again, and again,
          believing it did not load. It says what will arrive here instead. */}
      {loaded && !failed && rows.length === 0 ? (
        <View style={{ marginTop: 20 }}>
          <StubCard
            title="Nothing yet"
            body="Messages from the office show here. For example, an order not accepted, a day plan to agree, or a new task."
          />
        </View>
      ) : null}

      {loaded && failed ? (
        <View style={{ marginTop: 20 }}>
          <StubCard
            title="Could not read your notifications"
            body="Nothing is lost. They are still on this phone. Go back and open this screen again."
          />
        </View>
      ) : null}

      {WHENS.map((g) => {
        const items = rows.filter((n) => bucketOf(n.createdAt, days.today, days.yesterday) === g);
        if (items.length === 0) return null;
        return (
          <View key={g} style={{ marginTop: 20 }}>
            <SectionLabel style={{ marginBottom: 8 }}>{g}</SectionLabel>
            <ListCard>
              {items.map((n, i) => {
                const isUnread = n.readAt == null;
                const tone = TONE[n.kind] ?? TONE.neutral;
                const href = phoneRoute(n.href);
                const cta = href ? CTA[href.split('?')[0]] : undefined;
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
                      style={{
                        flexDirection: 'row',
                        gap: 10,
                        paddingHorizontal: 16,
                        paddingVertical: 14,
                        borderTopWidth: i ? 1 : 0,
                        borderTopColor: C.wash,
                        backgroundColor: isUnread ? C.surface : C.surfaceRead,
                      }}>
                      <UnreadDot unread={isUnread} tint={tone.fg} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                          <T style={[{ flex: 1, minWidth: 0, fontSize: 16, color: C.ink }, weight(isUnread ? 600 : 500)]}>
                            {n.title}
                          </T>
                          <T s="micro">{stamp(n.createdAt, g)}</T>
                        </View>
                        <T s="small" style={{ marginTop: 3 }}>{n.body}</T>
                        {cta ? (
                          <View style={{ marginTop: 8, flexDirection: 'row' }}>
                            <View
                              style={{
                                height: 22,
                                paddingHorizontal: 8,
                                borderRadius: 11,
                                backgroundColor: tone.bg,
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}>
                              <T style={[{ fontSize: 12, color: tone.fg }, weight(600)]}>{cta}</T>
                            </View>
                          </View>
                        ) : null}
                      </View>
                    </Pressable>
                  </Stagger>
                );
              })}
            </ListCard>
          </View>
        );
      })}
    </AppFrame>
  );
}
