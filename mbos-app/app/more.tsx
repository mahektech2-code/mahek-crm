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
import { listExpenses, listSamples } from '../src/data/requests';
import { priceDay } from '../src/data/travel';
import { cashInHand } from '../src/data/payments';
import { overdueSamples } from '../src/data/lead-samples';
import { openLeadCount } from '../src/data/leads';
import { pendingCount, queueCounts } from '../src/sync/queue';
import { savedMaps } from '../src/data/offline-maps';
import { bookMoney } from '../src/data/customer-account';
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
  toBank: number;
  lateSamples: number;
  overdueTasks: number;
  openLeads: number;
  pendingExpenses: number;
  daySent: boolean;
  legsToday: number;
  openSamples: number;
  toSend: number;
  rejected: number;
  owing: number;
};

const EMPTY: Counts = {
  savedMaps: 0,
  toBank: 0,
  lateSamples: 0,
  overdueTasks: 0,
  openLeads: 0,
  pendingExpenses: 0,
  daySent: false,
  legsToday: 0,
  openSamples: 0,
  toSend: 0,
  rejected: 0,
  owing: 0,
};

function groupsFor(n: Counts): { label: string; items: Item[] }[] {
  return [
    {
      label: 'Work',
      items: [
        /* THE SCREEN NOTHING ROUTED TO. `/nearby` answers the one question a
           salesman standing in a lane actually has — of the shops around me,
           which one now and why — and it was finished, tested and reachable
           from nowhere in the app. The only "near me" he could get to was the
           customers list's distance SORT, which answers the same question by
           the opposite rule: this one orders by what is worth doing and treats
           distance as a cost, and a shop with no reason to call is not on it at
           all. No badge, because working the answer out needs a fix and a read
           of every pinned shop, and a menu will not wait for either. */
        { label: 'Near me', badge: '', route: 'nearby' },
        { label: 'Tasks', badge: n.overdueTasks ? plural(n.overdueTasks, 'overdue', 'overdue') : '', route: 'tasks' },
        { label: 'Leads', badge: n.openLeads ? plural(n.openLeads, 'open', 'open') : '', route: 'leads' },
        /* §24 — the book and what is OWED on it are two questions, and the
           second is the one a morning is made of. The Leads row above is every
           lead he holds; this one is the four that are actually asking for
           something: due today, late, parked and coming back, and the ones
           nobody has promised anything about at all. No badge, because Home
           already carries the two figures and a third statement of them here
           is a number somebody has to reconcile rather than read. */
        { label: 'Pending actions', badge: '', route: 'lead-actions' },
        /* These two named a LIST and opened a capture form — the only two
           rows here that did. Punching an order and taking money both start
           at the + button, like every other capture; what was missing was
           anywhere to see what he had already done. */
        { label: 'Orders', badge: '', route: 'orders' },
        { label: 'Payments', badge: n.toBank ? plural(n.toBank, 'to bank', 'to bank') : '', route: 'collections' },
        /* The book as the Accounts app reads it: who owes what, every bill,
           every payment and where it went. Read-only — the office decides
           about money; this is so he can answer for it at the counter. The
           badge is how many of his shops owe money, from the office's own
           outstanding on the pull. */
        {
          label: 'Customer accounts',
          badge: n.owing ? plural(n.owing, 'owes', 'owe') : '',
          route: 'accounts',
        },
        /* LATE beats OPEN. Both are true, only one is a thing to do
           today, and a badge that is lit whenever anything is open is a badge
           that stops meaning anything. */
        {
          label: 'Samples',
          badge: n.lateSamples
            ? plural(n.lateSamples, 'late', 'late')
            : n.openSamples
              ? plural(n.openSamples, 'open', 'open')
              : '',
          route: 'samples',
        },
        { label: 'Reports', badge: '', route: 'reports' },
      ],
    },
    {
      label: 'Me',
      items: [
        { label: 'Attendance', badge: '', route: 'attendance' },
        { label: 'Leave', badge: '', route: 'leave' },
        { label: 'Salary', badge: '', route: 'salary' },
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
        { label: 'Send to office', badge: n.toSend ? n.toSend + ' to send' : '', route: 'sync' },
        /* The walkthrough opens on its own once per build; this is the way back
           to it for somebody who pressed "Do this later". */
        { label: 'Set up your phone', badge: '', route: 'setup' },
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

  /* Read here rather than inside the callback below, which held an empty
     dependency array — so a focus that landed before the session was restored
     passed '' to `priceDay` and `cashInHand`, and nothing re-ran when it
     arrived. The badges are the point of this screen, and the two that were
     silently empty are the cash he is carrying and the day he has to close. */
  const userId = boot.session?.user.id ?? '';

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      const today = isoDate(new Date());
      void Promise.all([
        listOpenTasks(),
        openLeadCount(),
        listExpenses(),
        listSamples(),
        pendingCount(),
        queueCounts(),
        priceDay(userId, today),
        savedMaps().catch(() => []),
        /* Cash he is carrying, as a COUNT of collections rather than a figure:
           a rupee amount in a menu badge reads as something owed to him. */
        cashInHand(userId),
        overdueSamples(today),
        bookMoney().catch(() => null),
      ]).then(([tasks, openLeads, expenses, samples, toSend, queue, today_, maps, cash, late, money]) => {
        if (!live) return;
        setCounts({
          savedMaps: maps.length,
          toBank: cash.carried.length,
          lateSamples: late.length,
          overdueTasks: tasks.filter((t) => bucketOf(t.dueDate, today) === 'Overdue').length,
          openLeads,
          pendingExpenses: expenses.filter((e) => e.state === 'Pending').length,
          openSamples: samples.filter((s) => s.state !== 'Converted' && s.state !== 'Rejected').length,
          toSend,
          rejected: queue.rejected ?? 0,
          daySent: today_.day?.lockedAt != null,
          legsToday: today_.legs.length,
          owing: money?.owing ?? 0,
        });
      });
      return () => {
        live = false;
      };
    }, [userId]),
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
    notify(i.label + ' is not ready yet.');
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
