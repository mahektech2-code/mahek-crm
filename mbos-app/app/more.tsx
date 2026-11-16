import React from 'react';
import { Text, View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame } from '../src/components/shell/AppFrame';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { color as C, weight } from '../src/theme/tokens';
import { useBoot } from '../src/state/boot';
import { useSignOut } from '../src/state/sign-out';
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
import { Pop, Stagger } from '../src/components/ui/motion';

/**
 * Everything the four tabs do not carry.
 *
 * The badges are the point of the screen: a list of nineteen links is not
 * worth opening, but "1 overdue" and "4 to send" are, and they are what make
 * the person come here rather than wait to be told. Every one of them is a
 * count from the local store — a badge that was a literal would be the one
 * thing on the screen that could not be trusted.
 */

/* `tone` is the badge's colour: amber for something waiting, red for
   something late or refused, green for a fact that is good news (maps saved).
   `glyph` and `ink` are the tile's mark from the Version 3 artboard. */
type Item = { label: string; badge: string; route?: string; tone?: BadgeTone; glyph: GlyphShape[]; ink: string };
type BadgeTone = 'warn' | 'danger' | 'ok';

const BADGE_TONE: Record<BadgeTone, { bg: string; fg: string }> = {
  warn: { bg: C.warnBg, fg: C.warnInk },
  danger: { bg: C.dangerBg, fg: C.danger },
  ok: { bg: C.successBg, fg: C.success },
};

const G: Record<string, GlyphShape[]> = {
  nearby: [{ c: [12, 12, 7] }, { c: [12, 12, 2.5] }, { p: 'M12 2v3M12 19v3M2 12h3M19 12h3' }],
  tasks: [{ r: [4, 4, 16, 16, 3] }, { p: 'M8 12l3 3 5-6' }],
  leads: [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }],
  actions: [{ p: 'M5 4h10l4 4v12H5z' }, { p: 'M9 12h6M9 16h4' }],
  orders: [{ p: 'M4 5h2l2 11h10l2-8H7' }, { c: [10, 20, 1] }, { c: [17, 20, 1] }],
  payments: [{ r: [3, 6, 18, 13, 2] }, { p: 'M3 10h18M16 14h2' }],
  accounts: [{ p: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z' }, { p: 'M9 8h6M9 12h6' }],
  samples: [{ p: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3' }],
  reports: [{ p: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }],
  attendance: [{ c: [12, 12, 8] }, { p: 'M12 8v4l3 2' }],
  leave: [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16M9 3v4M15 3v4M9 15h6' }],
  holidays: [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16M9 3v4M15 3v4' }, { c: [12, 15, 1.5] }],
  salary: [{ p: 'M7 5h10M7 9h10M10 5c3 0 4 2 4 4s-2 4-5 4h-2l7 7' }],
  travel: [{ c: [6, 18, 2] }, { c: [18, 6, 2] }, { p: 'M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6' }],
  expenses: [{ p: 'M6 3h12v18l-3-2-3 2-3-2-3 2z' }, { p: 'M9 8h6M9 12h6M9 16h3' }],
  policy: [{ p: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' }, { p: 'M8.5 12l2.5 2.5 4.5-5' }],
  performance: [{ p: 'M3 17l6-6 4 4 8-8M15 7h6v6' }],
  catalogue: [{ p: 'M8 3h8v4H8zM6 7h12l-1 14H7z' }],
  docs: [{ p: 'M6 3h8l4 4v14H6z' }, { p: 'M14 3v4h4' }],
  maps: [{ p: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z' }, { p: 'M9 4v14M15 6v14' }],
  profile: [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }],
  sync: [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }, { p: 'M12 11v4M12 11l-2 2M12 11l2 2' }],
  setup: [{ r: [7, 3, 10, 18, 2] }, { p: 'M11 18h2' }],
  rejections: [{ c: [12, 12, 8] }, { p: 'M6.5 6.5l11 11' }],
  signOut: [{ p: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9' }],
};
const CHEV: GlyphShape[] = [{ p: 'M9 5l7 7-7 7' }];

type Counts = {
  savedMaps: number;
  toBank: number;
  lateSamples: number;
  overdueTasks: number;
  openLeads: number;
  pendingExpenses: number;
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
  legsToday: 0,
  openSamples: 0,
  toSend: 0,
  rejected: 0,
  owing: 0,
};

/* `grid` groups are drawn as tiles, the rest as a list — the Settings group is
   a list in Version 3, because a sign-out tile beside a profile tile reads as
   two equal choices. */
function groupsFor(n: Counts): { label: string; grid: boolean; items: Item[] }[] {
  return [
    {
      label: 'Work',
      grid: true,
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
        { label: 'Near me', badge: '', route: 'nearby', glyph: G.nearby, ink: C.primary },
        { label: 'Tasks', badge: n.overdueTasks ? plural(n.overdueTasks, 'overdue', 'overdue') : '', route: 'tasks', glyph: G.tasks, ink: C.primary },
        { label: 'Leads', badge: n.openLeads ? plural(n.openLeads, 'open', 'open') : '', route: 'leads', glyph: G.leads, ink: C.primaryDeep },
        /* §24 — the book and what is OWED on it are two questions, and the
           second is the one a morning is made of. The Leads row above is every
           lead he holds; this one is the four that are actually asking for
           something: due today, late, parked and coming back, and the ones
           nobody has promised anything about at all. No badge, because Home
           already carries the two figures and a third statement of them here
           is a number somebody has to reconcile rather than read. */
        { label: 'Pending actions', badge: '', route: 'lead-actions', glyph: G.actions, ink: C.primaryDeep },
        /* These two named a LIST and opened a capture form — the only two
           rows here that did. Punching an order and taking money both start
           at the + button, like every other capture; what was missing was
           anywhere to see what he had already done. */
        { label: 'Orders', badge: '', route: 'orders', glyph: G.orders, ink: C.primary },
        { label: 'Payments', badge: n.toBank ? plural(n.toBank, 'to bank', 'to bank') : '', route: 'collections', glyph: G.payments, ink: C.success },
        /* The book as the Accounts app reads it: who owes what, every bill,
           every payment and where it went. Read-only — the office decides
           about money; this is so he can answer for it at the counter. The
           badge is how many of his shops owe money, from the office's own
           outstanding on the pull. */
        {
          label: 'Customer accounts',
          badge: n.owing ? plural(n.owing, 'owes', 'owe') : '',
          route: 'accounts',
          glyph: G.accounts,
          ink: C.danger,
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
          tone: n.lateSamples ? 'danger' : 'warn',
          glyph: G.samples,
          ink: C.primaryDeep,
        },
        { label: 'Reports', badge: '', route: 'reports', glyph: G.reports, ink: C.body },
      ],
    },
    {
      /* Version 3 calls the whole tab "Me", so the group about his own days
         and pay is named for what is in it. */
      label: 'My days & pay',
      grid: true,
      items: [
        { label: 'Attendance', badge: '', route: 'attendance', glyph: G.attendance, ink: C.success },
        { label: 'Leave', badge: '', route: 'leave', glyph: G.leave, ink: C.primary },
        { label: 'Holidays', badge: '', route: 'holidays', glyph: G.holidays, ink: C.warnInk },
        { label: 'Salary', badge: '', route: 'salary', glyph: G.salary, ink: C.success },
        { label: 'Today’s travel', badge: n.legsToday ? String(n.legsToday) : '', route: 'travel', glyph: G.travel, ink: C.body },
        { label: 'Expenses', badge: n.pendingExpenses ? n.pendingExpenses + ' pending' : '', route: 'expenses', glyph: G.expenses, ink: C.primary },
        { label: 'What you are allowed', badge: '', route: 'policy', glyph: G.policy, ink: C.success },
        { label: 'Performance', badge: '', route: 'performance', glyph: G.performance, ink: C.primary },
      ],
    },
    {
      label: 'Resources',
      grid: true,
      items: [
        { label: 'Product catalogue', badge: '', route: 'catalogue', glyph: G.catalogue, ink: C.body },
        { label: 'Documents', badge: '', route: 'docs', glyph: G.docs, ink: C.body },
        /* The Knowledge centre is not listed. Its modules cannot be opened or
           finished on the phone yet — every tap raised an error — and a row
           that leads only to "not yet" is a row that should not be drawn. It
           comes back when a course can actually be taken here. */
        /* The badge counts what is ON THE PHONE, not how many places could be
           saved. "3 saved" is a fact; "9 available" would be an advertisement
           for a several-hundred-megabyte download in a menu. */
        {
          label: 'Offline maps',
          badge: n.savedMaps ? plural(n.savedMaps, 'saved', 'saved') : '',
          route: 'maps',
          tone: 'ok',
          glyph: G.maps,
          ink: C.body,
        },
      ],
    },
    /* `WhatsApp` was here and went nowhere — MBOS has no WhatsApp screen, and a
     menu row whose only job is to say "not built" is a row that should not be
     drawn. Messaging a customer happens from their card, where their number
     is. The group goes with it, being empty. */
    {
      label: 'Settings',
      grid: false,
      items: [
        /* Profile carries the preferences too, so "App preferences" — a second
           row opening the same screen — is gone. */
        { label: 'Profile and preferences', badge: '', route: 'profile', glyph: G.profile, ink: C.body },
        { label: 'Send to office', badge: n.toSend ? n.toSend + ' to send' : '', route: 'sync', glyph: G.sync, ink: C.body },
        /* The walkthrough opens on its own once per build; this is the way back
           to it for somebody who pressed "Do this later". */
        { label: 'Set up your phone', badge: '', route: 'setup', glyph: G.setup, ink: C.body },
        /* A refusal has its own row: it is not something waiting to go out, it
           is something the office has already said no to. */
        { label: 'Not accepted', badge: n.rejected ? String(n.rejected) : '', route: 'rejections', tone: 'danger', glyph: G.rejections, ink: C.danger },
        /* "Your days" opened Attendance, which is already listed under Me. One
           screen, one row. */
        { label: 'Sign out', badge: '', glyph: G.signOut, ink: C.danger },
      ],
    },
  ];
}

export default function MoreScreen() {
  const boot = useBoot();
  const askSignOut = useSignOut();

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
      ])
        .then(([tasks, openLeads, expenses, samples, toSend, queue, today_, maps, cash, late, money]) => {
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
            legsToday: today_.legs.length,
            owing: money?.owing ?? 0,
          });
        })
        /* One read failing used to leave every badge blank and an unhandled
           rejection behind. The rows still work; only the counts are missing,
           and the next visit to this screen asks again. */
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }, [userId]),
  );

  const GROUPS = groupsFor(counts);

  const open = (i: Item) => {
    if (i.route) return router.push(`/${i.route}?from=more`);
    /* The only row with no route. It asks first, like Profile does — see
       `useSignOut`. */
    askSignOut();
  };

  const user = boot.session?.user;
  const role = user?.designation?.trim() || user?.role?.trim() || null;
  const identity = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[{ fontSize: 15, lineHeight: 21, color: '#FFFFFF' }, weight(700)]}>{user?.initials ?? '··'}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 25, letterSpacing: -0.4, color: C.ink }, weight(800)]}>
          Me
        </Text>
        {user ? (
          <Text numberOfLines={1} style={{ fontSize: 12, color: C.lavenderMuted }}>
            {user.name.split(' ')[0] + (role ? ' · ' + role : '')}
          </Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <AppFrame
      title="More"
      activeTab="more"
      tone="lavender"
      showTitle={false}
      heroTop={identity}
      contentStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 }}>
      {/* The GROUPS settle in one after another, not the tiles: thirty tiles
          cascading down a menu is a wait, and four groups is a glance. */}
      {GROUPS.map((g, gi) => (
        <Stagger key={g.label} index={gi} style={{ marginBottom: 22 }}>
          <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
            {g.label}
          </Text>
          {g.grid ? (
            <View style={{ gap: 10, marginTop: 10 }}>
              {rowsOf3(g.items).map((row, ri) => (
                <View key={ri} style={{ flexDirection: 'row', gap: 10 }}>
                  {row.map((i, ci) =>
                    i ? <Tile key={i.label} item={i} onPress={() => open(i)} /> : <View key={'gap' + ci} style={{ flex: 1 }} />,
                  )}
                </View>
              ))}
            </View>
          ) : (
            <View style={{ marginTop: 10, backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 14 }}>
              {g.items.map((i, n) => (
                <ListRow key={i.label} item={i} first={n === 0} onPress={() => open(i)} />
              ))}
            </View>
          )}
        </Stagger>
      ))}
    </AppFrame>
  );
}

/* Three to a row, the last row padded so its tiles keep a third each. */
function rowsOf3(items: Item[]): (Item | null)[][] {
  const out: (Item | null)[][] = [];
  for (let i = 0; i < items.length; i += 3) {
    const row: (Item | null)[] = items.slice(i, i + 3);
    while (row.length < 3) row.push(null);
    out.push(row);
  }
  return out;
}

/** A 92-tall white tile: the mark, the name, and the badge in its corner. */
function Tile({ item, onPress }: { item: Item; onPress: () => void }) {
  const t = BADGE_TONE[item.tone ?? 'warn'];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={item.label + (item.badge ? ', ' + item.badge : '')}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        minHeight: 92,
        paddingVertical: 10,
        borderRadius: 20,
        backgroundColor: pressed ? C.wash : C.surface,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 6,
      })}>
      <Glyph shapes={item.glyph} size={24} color={item.ink} />
      <Text numberOfLines={2} style={[{ fontSize: 13, lineHeight: 16, color: C.ink, textAlign: 'center' }, weight(700)]}>
        {item.label}
      </Text>
      {/* Pops when its count CHANGES — "2 to send" becoming "1 to send" after
          a sync is the news this screen exists for. */}
      {item.badge ? (
        <Pop trigger={item.badge} style={{ position: 'absolute', top: 8, right: 8 }}>
          <View style={{ minHeight: 22, minWidth: 22, paddingHorizontal: 7, borderRadius: 11, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
            <Text numberOfLines={1} style={[{ fontSize: 11, color: t.fg }, weight(800)]}>{item.badge}</Text>
          </View>
        </Pop>
      ) : null}
    </Pressable>
  );
}

/** A 56-tall settings row: the mark, the name, the badge, a chevron. */
function ListRow({ item, first, onPress }: { item: Item; first: boolean; onPress: () => void }) {
  const t = BADGE_TONE[item.tone ?? 'warn'];
  const signOut = !item.route;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={item.label + (item.badge ? ', ' + item.badge : '')}
      style={({ pressed }) => ({
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: C.hairline,
        opacity: pressed ? 0.7 : 1,
      })}>
      <Glyph shapes={item.glyph} size={20} color={item.ink} />
      <Text style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21, color: signOut ? C.danger : C.ink }, weight(600)]}>{item.label}</Text>
      {item.badge ? (
        <Pop trigger={item.badge}>
          <View style={{ minHeight: 26, minWidth: 26, paddingHorizontal: 9, borderRadius: 13, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 12, lineHeight: 17, color: t.fg }, weight(800)]}>{item.badge}</Text>
          </View>
        </Pop>
      ) : null}
      {signOut ? null : <Glyph shapes={CHEV} size={16} color={C.faint} />}
    </Pressable>
  );
}
