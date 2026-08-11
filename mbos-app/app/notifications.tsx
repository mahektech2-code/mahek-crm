import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { ListCard, SectionLabel, T } from '../src/components/ui/primitives';
import { color as C, type, weight } from '../src/theme/tokens';
import { dmy, isoDate, plural } from '../src/lib/format';
import { listNotifications, markAllRead, markRead, type Notification } from '../src/data/notifications';

/**
 * The bell.
 *
 * Every row goes somewhere — a notification that only announces is a
 * notification nobody reads twice — and opening one marks it read, because
 * having read it is exactly what tapping it means.
 */

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
  '/customers': 'Ring the customer',
  '/customer': 'Ring the customer',
  '/tasks': 'Open tasks',
  '/journey': 'See the route',
  '/expenses': 'Open expenses',
  '/leave': 'Open leave',
  '/docs': 'Open documents',
  '/sync': 'Waiting to send',
  '/rejections': 'Not accepted',
};

function bucketOf(createdAt: number, today: string, yesterday: string): 'Today' | 'Yesterday' | 'Earlier' {
  const day = isoDate(new Date(createdAt));
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : 'Earlier';
}

/** 8:40 am for the last two days; the date itself for anything older. */
function stamp(createdAt: number, bucket: string): string {
  const d = new Date(createdAt);
  if (bucket === 'Earlier') return dmy(isoDate(d));
  const h = d.getHours();
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return hour + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + suffix;
}

export default function NotificationsScreen() {
  const back = useCameFrom('home');
  const [rows, setRows] = React.useState<Notification[]>([]);
  const [days] = React.useState(() => ({
    today: isoDate(new Date()),
    yesterday: isoDate(new Date(Date.now() - 86_400_000)),
  }));

  const load = React.useCallback(() => {
    let live = true;
    void listNotifications().then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const unread = rows.filter((n) => n.readAt == null).length;

  return (
    <AppFrame title="Notifications" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={type.h1}>Notifications</T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {unread ? plural(unread, 'unread notification') : 'Nothing unread'}
          </T>
        </View>
        {unread > 0 ? (
          <Pressable
            onPress={async () => {
              await markAllRead();
              load();
            }}
            accessibilityRole="button"
            style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 12, marginRight: -12, justifyContent: 'center' }}>
            <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Mark all read</T>
          </Pressable>
        ) : null}
      </View>

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
                const cta = n.href ? CTA[n.href.split('?')[0]] : undefined;
                return (
                  <Pressable
                    key={n.id}
                    onPress={async () => {
                      await markRead(n.id);
                      load();
                      /* Reading is not acknowledging — a priority notification
                         is cleared by the screen that fixes the problem, never
                         by this one. */
                      if (n.href) router.push(`${n.href}${n.href.includes('?') ? '&' : '?'}from=notifications`);
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
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        marginTop: 6,
                        backgroundColor: isUnread ? tone.fg : 'transparent',
                      }}
                    />
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
                );
              })}
            </ListCard>
          </View>
        );
      })}
    </AppFrame>
  );
}
