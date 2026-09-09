import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame } from '../src/components/shell/AppFrame';
import { SectionLabel, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, weight } from '../src/theme/tokens';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { signOut as signOutReal } from '../src/data/session';
import { bucketOf, listOpenTasks } from '../src/data/tasks';
import { leaveBalances, listExpenses, listSamples } from '../src/data/requests';
import { priceDay } from '../src/data/travel';
import { openLeadCount } from '../src/data/leads';
import { pendingCount, queueCounts } from '../src/sync/queue';
import { savedMaps } from '../src/data/offline-maps';
import { isoDate, plural } from '../src/lib/format';

/**
 * Everything the four tabs do not carry.
 *
 * The badges are the point of the screen: a list of nineteen links is not
 * worth opening, but "1 overdue" and "4 to send" are, and they are what make
 * the person come here rather than wait to be told. Every one of them is a
 * count from the local store — a badge that was a literal would be the one
 * thing on the screen that could not be trusted.
 */

type Item = { label: string; badge: string; route?: string };

type Counts = {
  savedMaps: number;
  overdueTasks: number;
  openLeads: number;
  leaveLeft: number;
  pendingExpenses: number;
  dayOpen: boolean;
  daySent: boolean;
  legsToday: number;
  openSamples: number;
  toSend: number;
  rejected: number;
};

const EMPTY: Counts = {
  savedMaps: 0,
  overdueTasks: 0,
  openLeads: 0,
  leaveLeft: 0,
  pendingExpenses: 0,
  dayOpen: false,
  daySent: false,
  legsToday: 0,
  openSamples: 0,
  toSend: 0,
  rejected: 0,
};

function groupsFor(n: Counts): { label: string; items: Item[] }[] {
  return [
    {
      label: 'Work',
      items: [
        { label: 'Tasks', badge: n.overdueTasks ? plural(n.overdueTasks, 'overdue', 'overdue') : '', route: 'tasks' },
        { label: 'Leads', badge: n.openLeads ? plural(n.openLeads, 'open', 'open') : '', route: 'leads' },
        { label: 'Orders', badge: '', route: 'order' },
        { label: 'Payments', badge: '', route: 'pay' },
        { label: 'Samples', badge: n.openSamples ? plural(n.openSamples, 'open', 'open') : '', route: 'samples' },
        { label: 'Reports', badge: '', route: 'reports' },
      ],
    },
    {
      label: 'Me',
      items: [
        { label: 'Attendance', badge: '', route: 'attendance' },
        { label: 'Leave', badge: n.leaveLeft ? n.leaveLeft + ' left' : '', route: 'leave' },
        { label: 'Salary', badge: '', route: 'salary' },
        /* The day comes before the claims that hang off it: the meal
           allowance is worked out from the times on it, so a salesman who
           never opens this screen is a salesman never paid for his food. */
        { label: 'Your day', badge: n.dayOpen ? '' : 'not started', route: 'day' },
        { label: "Today's travel", badge: n.legsToday ? String(n.legsToday) : '', route: 'travel' },
        { label: 'Close the day', badge: n.daySent ? 'sent' : '', route: 'eod' },
        { label: 'Expenses', badge: n.pendingExpenses ? n.pendingExpenses + ' pending' : '', route: 'expenses' },
        { label: 'What you are allowed', badge: '', route: 'policy' },
        { label: 'Performance', badge: '', route: 'performance' },
      ],
    },
    {
      label: 'Resources',
      items: [
        { label: 'Product catalogue', badge: '', route: 'catalogue' },
        { label: 'Documents', badge: '', route: 'docs' },
        { label: 'Knowledge centre', badge: '', route: 'knowledge' },
        /* The badge counts what is ON THE PHONE, not how many places could be
           saved. "3 saved" is a fact; "9 available" would be an advertisement
           for a several-hundred-megabyte download in a menu. */
        {
          label: 'Offline maps',
          badge: n.savedMaps ? plural(n.savedMaps, 'saved', 'saved') : '',
          route: 'maps',
        },
      ],
    },
    /* `WhatsApp` was here and went nowhere — MBOS has no WhatsApp screen, and a
     menu row whose only job is to say "not built" is a row that should not be
     drawn. Messaging a customer happens from their card, where their number
     is. The group goes with it, being empty. */
    {
      label: 'Settings',
      items: [
        { label: 'Profile', badge: '', route: 'profile' },
        /* The Preferences card lives on the profile screen — this used to toast
         rather than open the thing it names. */
      { label: 'App preferences', badge: '', route: 'profile' },
        { label: 'Sync', badge: n.toSend ? n.toSend + ' to send' : '', route: 'sync' },
        /* A refusal has its own row: it is not something waiting to go out, it
           is something the office has already said no to. */
        { label: 'Not accepted', badge: n.rejected ? String(n.rejected) : '', route: 'rejections' },
        /* `attendance` IS the sign-in log — one row per person per day, which is
         exactly what this asks for. MahekOne is careful that it is NOT a record
         of hours worked, so the destination is named for the day rather than
         for the login. */
      { label: 'Your days', badge: '', route: 'attendance' },
        { label: 'Sign out', badge: '' },
      ],
    },
  ];
}

export default function MoreScreen() {
  const notify = useStore((s) => s.notify);
  const signOut = useStore((s) => s.signOut);
  const boot = useBoot();

  const [counts, setCounts] = React.useState<Counts>(EMPTY);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      const today = isoDate(new Date());
      void Promise.all([
        listOpenTasks(),
        openLeadCount(),
        leaveBalances(),
        listExpenses(),
        listSamples(),
        pendingCount(),
        queueCounts(),
        priceDay(boot.session?.user.id ?? '', today),
        savedMaps().catch(() => []),
      ]).then(([tasks, openLeads, balances, expenses, samples, toSend, queue, today_, maps]) => {
        if (!live) return;
        setCounts({
          savedMaps: maps.length,
          overdueTasks: tasks.filter((t) => bucketOf(t.dueDate, today) === 'Overdue').length,
          openLeads,
          leaveLeft: Math.round(balances.reduce((a, b) => a + b.available, 0)),
          pendingExpenses: expenses.filter((e) => e.state === 'Pending').length,
          openSamples: samples.filter((s) => s.state !== 'Converted' && s.state !== 'Rejected').length,
          toSend,
          rejected: queue.rejected ?? 0,
          dayOpen: today_.day != null,
          daySent: today_.day?.lockedAt != null,
          legsToday: today_.legs.length,
        });
      });
      return () => {
        live = false;
      };
    }, []),
  );

  const GROUPS = groupsFor(counts);

  const open = (i: Item) => {
    if (i.route) return router.push(`/${i.route}?from=more`);
    if (i.label === 'Sign out') {
      /* The outbox survives it — signing out clears the session and the
         tokens, never the work this phone has not sent yet. */
      void signOutReal().then(() => {
        signOut();
        boot.setSession(null);
        router.replace('/');
      });
      return;
    }
    notify(i.label + ' — next to build');
  };

  return (
    <AppFrame title="More" activeTab="more" contentStyle={{ paddingTop: 12, paddingBottom: 24 }}>
      {GROUPS.map((g) => (
        <View key={g.label} style={{ marginBottom: 20 }}>
          <SectionLabel style={{ paddingHorizontal: 16, paddingBottom: 8 }}>{g.label}</SectionLabel>
          <View
            style={{
              backgroundColor: C.surface,
              borderTopWidth: 1,
              borderBottomWidth: 1,
              borderColor: C.hairline,
            }}>
            {g.items.map((i, n) => (
              <Pressable
                key={i.label}
                onPress={() => open(i)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 56,
                    paddingHorizontal: 16,
                    borderTopWidth: n ? 1 : 0,
                    borderTopColor: C.wash,
                  },
                  pressed && { backgroundColor: C.wash },
                ]}>
                <T style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }}>{i.label}</T>
                {i.badge ? (
                  <View style={{ backgroundColor: C.warnEdge, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <T style={[{ fontSize: 12, color: C.warnInk }, weight(500)]}>{i.badge}</T>
                  </View>
                ) : null}
                <Icon name="forward" size={20} color={C.faint} strokeWidth={1.5} />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </AppFrame>
  );
}
