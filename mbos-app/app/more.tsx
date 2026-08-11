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
import { pendingCount, queueCounts } from '../src/sync/queue';
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
  overdueTasks: number;
  leaveLeft: number;
  pendingExpenses: number;
  openSamples: number;
  toSend: number;
  rejected: number;
};

const EMPTY: Counts = {
  overdueTasks: 0,
  leaveLeft: 0,
  pendingExpenses: 0,
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
        { label: 'Expenses', badge: n.pendingExpenses ? n.pendingExpenses + ' pending' : '', route: 'expenses' },
        { label: 'Performance', badge: '', route: 'performance' },
      ],
    },
    {
      label: 'Resources',
      items: [
        { label: 'Product catalogue', badge: '', route: 'catalogue' },
        { label: 'Documents', badge: '', route: 'docs' },
        { label: 'Knowledge centre', badge: '', route: 'knowledge' },
      ],
    },
    { label: 'Communication', items: [{ label: 'WhatsApp', badge: '' }] },
    {
      label: 'Settings',
      items: [
        { label: 'Profile', badge: '', route: 'profile' },
        { label: 'App preferences', badge: '' },
        { label: 'Sync', badge: n.toSend ? n.toSend + ' to send' : '', route: 'sync' },
        /* A refusal has its own row: it is not something waiting to go out, it
           is something the office has already said no to. */
        { label: 'Not accepted', badge: n.rejected ? String(n.rejected) : '', route: 'rejections' },
        { label: 'Login history', badge: '' },
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
        leaveBalances(),
        listExpenses(),
        listSamples(),
        pendingCount(),
        queueCounts(),
      ]).then(([tasks, balances, expenses, samples, toSend, queue]) => {
        if (!live) return;
        setCounts({
          overdueTasks: tasks.filter((t) => bucketOf(t.dueDate, today) === 'Overdue').length,
          leaveLeft: Math.round(balances.reduce((a, b) => a + b.available, 0)),
          pendingExpenses: expenses.filter((e) => e.state === 'Pending').length,
          openSamples: samples.filter((s) => s.state !== 'Converted' && s.state !== 'Rejected').length,
          toSend,
          rejected: queue.rejected ?? 0,
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
