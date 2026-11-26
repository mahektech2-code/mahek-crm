import React from 'react';
import { View, Text, Pressable, Platform, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useGlobalSearchParams, useLocalSearchParams, useNavigation, usePathname } from 'expo-router';
import { color as C, type, weight } from '../../theme/tokens';
import { Header, TabBar, TabBarAction, TAB_BAR_GAP, TAB_BAR_HEIGHT, type HeroTone, type StatusChip, type TabKey } from './Chrome';
import { ActionSheet, ConfirmSheet, StoreToast } from '../ui/overlays';
import { useTopSheet } from '../ui/sheet-stack';
import { backTarget, fromQuery, isTabRoot, screenOf } from './routes';
import { Icon } from '../ui/Icon';
import { useKeyboardHeight, useRevealFocusedField } from '../ui/keyboard';
import { useTicker } from '../ui/use-ticker';
import { Appear, Presence } from '../ui/motion';
import { StatusBar } from 'expo-status-bar';
import { feedback } from '../ui/feedback';
import { useCustomer, useDaysToAgreeCount, usePendingCount, useStore, useUnreadCountOrNull } from '../../state/store';
import { TravelGate } from './TravelGate';
import { refreshEverything } from '../../native/refresh';
import { useBoot } from '../../state/boot';
import { dayState, type Session } from '../../data/attendance';
import { hhmm, plural } from '../../lib/format';
import { elapsedLabel } from '../../lib/visit';
import { gpsVerdict, type GpsHealth } from '../../engines/gps-health';
import { gpsSignal } from '../../native/where';
import { hasPermission } from '../../native/location';
import { getConfig } from '../../data/config';
import { noteScreen } from '../../native/reload-guard';
import { noteCrashScreen } from '../../native/crash-log';

/** How tall the bar that pins under the status bar once the page scrolls is. */
const PINNED_BAR_HEIGHT = 44;

/**
 * The GPS light, from the radio rather than from a flag.
 *
 * It read `store.gps`, which is written only by the two check-in flows and the
 * visit screen's own acquire — so on a handset that reinstalled while already
 * checked in, none of them ever ran and the strip said "Finding GPS" for the
 * life of the install while the phone fixed to three metres every three
 * seconds. The rule is in `engines/gps-health.ts`; this is the polling.
 *
 * FIVE SECONDS, and only while the app is in front. `useTicker` already
 * handles the second half — it creates no timer when the app is backgrounded
 * and re-reads immediately on return — and a strip nobody is looking at does
 * not need refreshing. Nothing here touches the radio: every fix the app takes
 * already leaves its mark, so this is two local reads.
 */
function useGpsHealth(): GpsHealth {
  const tick = useTicker(5_000);
  const [health, setHealth] = React.useState<GpsHealth>('acquiring');

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [permitted, signal, threshold] = await Promise.all([
          hasPermission(),
          gpsSignal(),
          getConfig<number>('mbos.location.gpsAccuracyThresholdM', 50),
        ]);
        if (!alive) return;
        setHealth(
          gpsVerdict({
            permitted,
            ageSeconds: signal?.ageSeconds ?? null,
            accuracyM: signal?.accuracyM ?? null,
            /* The same sixty seconds `whereNow()` already calls `fresh`, so
               two parts of the app cannot disagree about what "now" means for
               one reading. */
            freshSeconds: 60,
            thresholdM: threshold,
          }),
        );
      } catch {
        /* A status light may not break a screen. Whatever could not be read is
           read again on the next tick, and until then the strip says it is
           still looking — which is the honest answer to not knowing. */
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return health;
}

/**
 * The frame. Every in-app screen renders its content inside one of these, and
 * in exchange gets the title bar, the status strip, the tab bar, the action
 * sheet, the confirm dialog and the toast — all of which must behave
 * identically everywhere or the app stops feeling like one app.
 */

/** Where the back link goes, and what it is called when it gets there. */
export const FROM_LABEL: Record<string, string> = {
  more: 'More',
  customers: 'Customers',
  home: 'Home',
  journey: 'Journey',
  journeys: 'Your journeys',
  customer: 'Customer',
  visit: 'Visit',
  order: 'Order',
  pay: 'Payment',
  tasks: 'Tasks',
  samples: 'Samples',
  sync: 'Waiting to send',
  attendance: 'Attendance',
  leave: 'Leave',
  salary: 'Salary',
  expenses: 'Expenses',
  performance: 'Performance',
  catalogue: 'Catalogue',
  docs: 'Documents',
  'doc-view': 'Document',
  knowledge: 'Knowledge',
  reports: 'Reports',
  notifications: 'Notifications',
  leads: 'Leads',
  lead: 'Lead',
  sample: 'Sample',
  'lead-prospect': 'Prospect details',
  'lead-qualify': 'Qualification',
  maps: 'Offline maps',
  pick: 'Pick your shops',
  nearby: 'Near me',
  accounts: 'Customer accounts',
  account: 'Account',
  profile: 'Profile',
  policy: 'Allowances',
  collections: 'Collections',
  orders: 'Orders',
  travel: 'Today’s travel',
  rejections: 'Not accepted',
  validate: 'Check call',
  'tracking-setup': 'Keep tracking on',
  'phone-setup': 'Phone setup',
};

/**
 * Reads the recorded entry route, so the label and the destination agree.
 *
 * THREE THINGS IT GOT WRONG, and each was a way back that was not one:
 *
 * - It went to the screen's NAME, `/lead`, with none of what the screen was
 *   showing — so back from the bell, opened on a lead, said "This lead is not
 *   on this phone". The full address now rides as `back` (see `routes.ts`).
 * - It went to whatever word it was given. Two screens fall back to `day`,
 *   and there is no `day` screen; that is now refused for one that exists.
 * - It always REPLACED, so More → Tasks → "‹ More" left the stack holding
 *   More twice, and Android's own Back walked through a copy of every screen
 *   he had come back from. Where the screen underneath IS the one being gone
 *   back to, it is popped instead — which also keeps its scroll and its
 *   filters — and a tab root is returned to rather than stacked again.
 *
 * `from` is still the bare screen name, because several screens ask it "did I
 * come from a visit?".
 */
export function useCameFrom(fallback = 'more') {
  const params = useLocalSearchParams<{ from?: string; back?: string }>();
  const navigation = useNavigation();
  const target = backTarget(params, fallback);
  const from = screenOf(target) ?? 'home';
  return {
    from,
    label: FROM_LABEL[from] ?? from.charAt(0).toUpperCase() + from.slice(1),
    go: () => {
      const state = navigation.getState?.();
      const below = state && state.index > 0 ? state.routes[state.index - 1] : null;
      if (below && below.name === from && router.canGoBack()) {
        router.back();
        return;
      }
      if (isTabRoot(target) && !target.includes('?')) router.dismissTo(target as never);
      else router.replace(target as never);
    },
  };
}

/** The inline "‹ More" link the design puts at the top of every sub-screen. */
export function BackLink(_props: { label: string; onPress: () => void }) {
  /* VERSION 3 draws the way back as the round button in the hero, which
     AppFrame now puts on every screen that is not a tab root. A second, inline
     "‹ More" under it would be the same control twice. */
  return null;
}

export function LegacyBackLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 48,
        marginTop: -8,
        marginLeft: -8,
        paddingHorizontal: 8,
      }}>
      <Text style={{ flexShrink: 1, fontSize: 18, lineHeight: 18, color: C.muted }}>‹</Text>
      <Text style={{ flexShrink: 1, fontSize: 15, lineHeight: 21, color: C.muted }}>{label}</Text>
    </Pressable>
  );
}

export function AppFrame({
  title,
  activeTab = null,
  onBack,
  footer,
  scroll = true,
  contentStyle,
  tone,
  hero,
  heroActions,
  showTitle = true,
  overlap = false,
  heroTop,
  footerBg,
  footerInsetBg,
  chipsBelowTitle = false,
  hideBack = false,
  children,
}: {
  /** Status chips under the title rather than in the top row. */
  chipsBelowTitle?: boolean;
  /** A screen the artboard draws with no way back (Visit saved). */
  hideBack?: boolean;
  /**
   * What shows round the pinned footer's corners. A Version 3 dock is often a
   * navy or canvas panel with rounded top corners, and a white wrapper behind
   * it drew white wedges at those corners. Defaults to white, as before.
   */
  footerBg?: string;
  /** What fills the gesture-bar inset under the footer; defaults to `footerBg`. */
  footerInsetBg?: string;
  title: string;
  /** The row the artboard draws first in the hero — see `Header`'s `top`. */
  heroTop?: React.ReactNode;
  /** The hero block's colour. Navy on the day screens, lavender elsewhere. */
  tone?: HeroTone;
  /** What the screen puts inside its hero block, under the title. */
  hero?: React.ReactNode;
  /** A screen's own round buttons in the hero, after the bell. */
  heroActions?: React.ReactNode;
  /** Off where `hero` names the screen itself. */
  showTitle?: boolean;
  /** The first card sits across the hero's bottom edge. */
  overlap?: boolean;
  activeTab?: TabKey | null;
  /** Draws the header chevron. Omitted screens have no chevron, per the design. */
  onBack?: () => void;
  /** The visit screen's pinned save bar. Nothing else uses it. */
  footer?: React.ReactNode;
  scroll?: boolean;
  contentStyle?: object;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  /* Every screen that is not a tab root gets the round back button, whether
     or not it wired one up — the inline "‹ More" links it used are gone. */
  const cameFrom = useCameFrom();

  /*
   * WHERE THIS SCREEN ACTUALLY IS.
   *
   * The shell used to send every one of these somewhere with `?from=home`
   * hardcoded, because it had no idea which screen it was wrapping. Two things
   * came out of that. The back link on nine sub-screens said "Home" whatever
   * you had opened them from, so leaving the order form dropped you somewhere
   * you had never been. And the bell pushed `/notifications` from the
   * notifications screen — a second copy of the page you were already reading,
   * with a back button that went to the first one.
   *
   * `usePathname` is the answer to both, and it has to be read HERE rather than
   * passed in by each screen: a prop every caller has to remember is a prop
   * somebody will forget, and this is exactly the kind of wrong nobody reports
   * because it looks like the app being odd rather than broken.
   */
  const pathname = usePathname();
  const here = (pathname ?? '').replace(/^\/+/, '').split('/')[0] || 'home';
  /* The NAME of this screen, and — where it is showing one record — the
     address of that record, so coming back lands on it. See `routes.ts`. */
  const searchParams = useGlobalSearchParams();
  const fromHere = fromQuery(pathname ?? '/home', searchParams);
  /* An update may reload only on a screen where nothing can be half done —
     see `reload-guard.ts`. Every screen draws this frame, so it is the one
     place that always knows where he is. */
  React.useEffect(() => {
    noteScreen(pathname ?? null);
    /* And so an error can say which screen it happened on. */
    noteCrashScreen(pathname ?? null);
  }, [pathname]);
  /* A sheet draws its own toast while it is open — see `sheet-stack.ts`. */
  const topSheet = useTopSheet();
  const keyboardHeight = useKeyboardHeight();
  const reveal = useRevealFocusedField(keyboardHeight);
  /* Whether the page has scrolled far enough that the header is passing under
     the status bar — see the pinned bar below. Set only when it flips, so a
     scroll is not a render per frame. */
  const [scrolledUnder, setScrolledUnder] = React.useState(false);
  const trackOffset = reveal.onScroll;
  const onScroll = React.useCallback(
    (e: Parameters<typeof trackOffset>[0]) => {
      trackOffset(e);
      const under = e.nativeEvent.contentOffset.y > PINNED_BAR_HEIGHT;
      setScrolledUnder((was) => (was === under ? was : under));
    },
    [trackOffset],
  );
  const [footerHeight, setFooterHeight] = React.useState(0);
  const unreadOrNull = useUnreadCountOrNull();
  const unread = unreadOrNull ?? 0;
  const waiting = usePendingCount();
  const daysToAgree = useDaysToAgreeCount();
  const clock = useDayClock();
  const checkInAt = clock.checkInAt;
  const checkedIn = checkInAt != null;
  /* From the radio, not from `store.gps` — see `useGpsHealth` above, and
     `engines/gps-health.ts` for why that field cannot answer this question. */
  const gps = useGpsHealth();
  const sheet = useStore((s) => s.sheet);
  const set = useStore((s) => s.set);
  const askTravel = useStore((s) => s.askTravel);
  const arrival = useStore((s) => s.arrival);
  const customer = useCustomer();
  const notify = useStore((s) => s.notify);
  const custId = useStore((s) => s.custId);
  const confirm = useStore((s) => s.confirm);
  const confirmReason = useStore((s) => s.confirmReason);
  const confirmErr = useStore((s) => s.confirmErr);
  const closeConfirm = useStore((s) => s.closeConfirm);
  const offerUpdate = useStore((s) => s.offerUpdate);
  const [refreshing, setRefreshing] = React.useState(false);

  /* The top-bar refresh. A new version wins the screen; otherwise the toast
     says what the sync did, so the press is never silent. */
  const refresh = React.useCallback(async (opts: { offerUpdates?: boolean } = {}) => {
    setRefreshing(true);
    try {
      const verdict = await refreshEverything();
      /* Only the BUTTON may raise the update prompt. A pull can happen by
         accident at the top of a half-filled order form, and a modal asking to
         restart the app is the last thing that should land on it then. */
      if (verdict.offer && opts.offerUpdates !== false) offerUpdate(verdict.offer);
      /* A note, not a confirmation: the summary is as often "No signal" or
         "3 entries were not accepted" as it is good news, and a success buzz
         on either would say the opposite of the sentence. */
      else notify(verdict.summary, 'info');
    } finally {
      setRefreshing(false);
    }
  }, [notify, offerUpdate]);

  const strip: StatusChip[] = [
    {
      key: 'att',
      icon: 'clock',
      text: checkInAt != null ? hhmm(checkInAt) : 'Not in',
      /*
       * SHORT ENOUGH FOR THE CELL IT HAS.
       *
       * Three cells share the width: on a 360pt handset each gets about 117,
       * less 16 of padding, less the dot and its gap, which leaves roughly 88
       * for the text. "Not checked in" and "In since 09:12" both measure about
       * that at 12pt, so the one fact somebody looks for first thing in the
       * morning rendered as "Not checked i…". These fit with room to spare.
       */
      label: checkInAt != null ? 'Punched in ' + hhmm(checkInAt) : 'Not punched in',
      tone: checkedIn ? 'ok' : 'idle',
      onPress: () => router.push(`/attendance${fromHere}`),
    },
    {
      key: 'gps',
      icon: 'locate',
      label: gps === 'locked' ? 'GPS locked' : gps === 'off' ? 'GPS off' : 'Finding GPS',
      tone: gps === 'locked' ? 'ok' : gps === 'off' ? 'warn' : 'idle',
      /*
       * Home IS the screen that explains this one — it is where the location
       * permission is asked for on first open, and where starting the day
       * takes the fix that sets this light. What it was not is a PUSH:
       * standing on Home, which is where he is most of the day, tapping "GPS
       * off" stacked a second copy of the page underneath itself, exactly the
       * defect the bell was rewritten to avoid two files down. Home is a tab
       * root, so it is reached the way the tab bar reaches one, and from Home
       * there is nowhere to go.
       */
      onPress: () => {
        if (here !== 'home') router.replace('/home');
      },
    },
    {
      key: 'sync',
      /*
       * Nothing waiting is GOOD news, and it was drawn amber.
       *
       * The pip was `warn` unconditionally, so "0 to send" sat under an amber
       * light on every screen of the app all day — which is how a warning
       * light stops meaning anything: the one state worth noticing looked
       * exactly like the ordinary one. And "0 to send" is a count of nothing,
       * where the fact somebody wants is that the handset is clear.
       *
       * "Waiting" rather than "to send" because `pendingCount` now counts a
       * refused record too, and a refusal is not going to be sent — it is
       * waiting for him. It is also the word the Sync card's own headline uses
       * for the same number, and the two disagreeing about one queue on one
       * screen is what this was: three refusals read "3 things waiting" on the
       * card under a green "All sent" thirty points above it.
       */
      label: waiting === 0 ? 'All sent' : `${waiting} waiting to send`,
      icon: waiting === 0 ? 'synced' : 'upload',
      text: waiting === 0 ? undefined : String(waiting),
      tone: waiting === 0 ? 'ok' : 'warn',
      onPress: () => router.push(`/sync${fromHere}`),
    },
  ];

  /*
   * THE SHOP IT WOULD START FOR, said before it starts.
   *
   * `custId` is whatever shop was opened LAST — this morning's statement
   * check, a record looked up on the way out — and the quick action started a
   * trip to it unnamed, from a menu on a screen that may have nothing to do
   * with that shop. A salesman pressing "Start visit" outside shop B set off,
   * on the record, for shop A. So it names the shop and asks, and with no shop
   * open it sends him to choose one rather than refusing. The sub-line said
   * "Pick how you travel", a question this app stopped asking when the vehicle
   * moved to the punch-in.
   */
  const askConfirm = useStore((s) => s.askConfirm);
  const visitTarget = custId ? customer?.name ?? null : null;
  const actionItems = [
    {
      glyph: 'visit',
      label: 'Start visit',
      sub: visitTarget ? `To ${visitTarget}? You confirm first` : 'Choose the shop, then set off',
      run: () => {
        /* One shop at a time. See the bar below: a salesman standing outside a
           shop he has arrived at is not about to set off for another, and
           letting him would leave an arrival nobody could ever close. */
        if (arrival && arrival.checkedInAt == null) {
          return notify(`Check in at ${arrival.customerName} first. You reached there at ${hhmm(arrival.arrivedAt)}.`, 'error');
        }
        /* And one visit at a time: the one he is in has to be checked out of,
           with its questions answered, before another can begin. */
        if (arrival && arrival.checkedInAt != null) {
          return notify(`Check out of ${arrival.customerName} first. You are still in that visit.`, 'error');
        }
        if (!custId || !visitTarget) {
          notify('Choose the shop, then press Start visit on it.', 'info');
          router.push(`/customers${fromHere}`);
          return;
        }
        const target = { customerId: custId, customerName: visitTarget };
        askConfirm({
          title: `Start visit to ${target.customerName}?`,
          body: 'Your trip to this shop starts now. To visit a different shop, choose it from Customers.',
          confirmLabel: 'Start visit',
          cancelLabel: 'Not now',
          tone: 'navy',
          run: () => askTravel(target),
        });
      },
    },
    { glyph: 'order', tint: C.primary, label: 'Punch order', sub: 'From their usual products', run: () => router.push(`/order${fromHere}`) },
    { glyph: 'wallet', tint: C.success, label: 'Collect payment', sub: 'Cash, cheque, UPI or transfer', run: () => router.push(`/pay${fromHere}`) },
    /* The form is asked for here and opened by the Leads screen, so the shop
       he is standing outside is typed in rather than found for a second time. */
    { glyph: 'person', tint: C.primaryDeep, label: 'Add lead', sub: 'A shop you just walked past', run: () => { set({ sheet: 'leadForm' }); router.push(`/leads${fromHere}`); } },
    { glyph: 'camera', tint: C.warnInk, label: 'Add expense', sub: 'Take a photo of the bill', run: () => router.push(`/expenses${fromHere}`) },
    { glyph: 'task', tint: C.ink, label: 'Create task', sub: 'For you or for someone else', run: () => router.push(`/tasks${fromHere}`) },
    { glyph: 'sample', tint: C.primaryDeep, label: 'Request sample', sub: 'Sent for approval', run: () => router.push(`/samples${fromHere}`) },
  ];

  /**
   * The scroll area lifts by exactly the keyboard's height.
   *
   * `automaticallyAdjustKeyboardInsets` does this on iOS on its own; Android
   * runs edge-to-edge here, so its window does not resize and the padding has
   * to be applied by hand or the field being typed into sits behind the keys.
   */
  const isRoot = activeTab != null && onBack == null && ['home', 'journey', 'customers', 'more'].includes(here);
  const back = hideBack ? undefined : onBack ?? (isRoot ? undefined : cameFrom.go);
  const heroTone: HeroTone = tone ?? (here === 'home' || here === 'journey' ? 'navy' : 'lavender');
  const showsTabBar = keyboardHeight === 0 && !footer;
  const pinnedTitle = title === 'MBOS' && FROM_LABEL[here] ? FROM_LABEL[here] : title;
  const header = (
    <Header
      /* Twelve screens passed "MBOS" as their title, so the bar said the app's
         name on Profile, Salary, Orders and the rest and never where you were.
         Those screens get their own name from the one table the back links
         already read. */
      title={title === 'MBOS' && FROM_LABEL[here] ? FROM_LABEL[here] : title}
      tone={heroTone}
      showTitle={showTitle}
      onBack={back}
      backLabel={onBack ? undefined : cameFrom.label}
      unread={unread}
      unreadLoaded={unreadOrNull !== null}
      onRefresh={() => void refresh()}
      refreshing={refreshing}
      /* No bell on the notifications screen. A control whose whole job is to
         bring you here is furniture once you have arrived, and tapping it
         stacked a second copy of the page. */
      onBell={here === 'notifications' ? undefined : () => router.push(`/notifications${fromHere}`)}
      chips={strip}
      actions={heroActions}
      top={heroTop}
      chipsBelowTitle={chipsBelowTitle}
      overlap={overlap}>
      {hero}
    </Header>
  );
  /* The floating bar sits over the content, so the last row needs room to
     scroll clear of it. */
  const barClearance = showsTabBar ? insets.bottom + TAB_BAR_GAP + TAB_BAR_HEIGHT + 16 : 0;
  const inner = [contentStyle, overlap ? { marginTop: -28 } : null];

  const body = scroll ? (
    <ScrollView
      ref={reveal.ref}
      onScroll={onScroll}
      scrollEventThrottle={16}
      style={{ flex: 1 }}
      contentContainerStyle={[{ paddingBottom: barClearance }, keyboardHeight > 0 && { paddingBottom: keyboardHeight + 24 }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      showsVerticalScrollIndicator={false}
      /* PULL DOWN TO REFRESH runs the same thing as the header's refresh
         button — send, fetch, look for a new version — because pulling a list
         down is the gesture every phone has taught people for "get me the
         latest", and the button in the corner is the one they never find. */
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            feedback('tap');
            void refresh({ offerUpdates: false });
          }}
          colors={[C.primary]}
          tintColor={C.primary}
          progressBackgroundColor={C.surface}
        />
      }>
      {/* The quieter half of the transition: the screen has arrived, and this
          is it settling. It also covers the frame or two where SQLite has not
          answered yet, so data reads as arriving rather than popping in. */}
      {header}
      <View style={inner}>
        <Appear>{children}</Appear>
      </View>
    </ScrollView>
  ) : (
    <View style={{ flex: 1 }}>
      {header}
      <View style={[{ flex: 1 }, ...inner, showsTabBar ? { paddingBottom: barClearance } : null]}>
        <Appear style={{ flex: 1 }}>{children}</Appear>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.canvas, paddingTop: insets.top }}>
      <StatusBar style={heroTone === 'navy' ? 'light' : 'dark'} />
      {/* The status bar area takes the hero's colour, so the block reads as
          reaching the top of the glass. */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top, backgroundColor: heroTone === 'navy' ? C.navy : heroTone === 'canvas' ? C.canvas : C.lavender }} />
      {body}
      {/*
        THE PAGE WAS CUT BY AN EDGE NOBODY COULD SEE. The header scrolls with
        the page, and the only thing over it was the status-bar strip in the
        hero's own colour — so a scrolled page showed half a row of figures
        sliced off under the clock, navy on navy, reading as a broken layout
        on every screen. Once the page has scrolled under the status bar a
        pinned bar takes over: the screen's name, a hairline and a shadow, so
        what scrolls away disappears under something rather than into nothing.
      */}
      {scroll && scrolledUnder ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: insets.top,
            left: 0,
            right: 0,
            height: PINNED_BAR_HEIGHT,
            justifyContent: 'center',
            paddingHorizontal: 20,
            backgroundColor: heroTone === 'navy' ? C.navy : heroTone === 'canvas' ? C.canvas : C.lavender,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: heroTone === 'navy' ? 'rgba(255,255,255,0.12)' : C.hairline,
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}>
          <Text
            numberOfLines={1}
            style={[{ fontSize: 16, lineHeight: 21, color: heroTone === 'navy' ? C.onNavy : C.ink }, weight(700)]}>
            {pinnedTitle}
          </Text>
        </View>
      ) : null}

      {/*
        THE WAY BACK INTO A SHOP HE IS ALREADY STANDING OUTSIDE.
        "Not yet" on the arrival screen is a real answer and it has to cost him
        nothing to change his mind — so the arrival follows him onto every
        screen until he goes in. It is not a nag: it is the ONLY control this
        app offers while one is outstanding, which is what makes it findable
        rather than something to dismiss. Hidden on the visit screen itself,
        where the same question is already the whole page.
      */}
      {/* Each of these three bars rises into place and sinks out of it rather
          than blinking — a bar that appears in one frame over the bottom of a
          list reads as the list being cut off. */}
      {/* With the floating bar they float too, just above it. */}
      <View pointerEvents="box-none" style={showsTabBar ? { position: 'absolute', left: 14, right: 14, bottom: barClearance - 8 } : { paddingHorizontal: 14, paddingBottom: 8 }}>
      <Presence show={!!arrival && arrival.checkedInAt == null && here !== 'visit'} distance={12}>
      {arrival && arrival.checkedInAt == null && here !== 'visit' ? (
        <ArrivedBar
          name={arrival.customerName}
          at={arrival.arrivedAt}
          onPress={() => {
            set({ custId: arrival.customerId });
            router.push('/visit');
          }}
        />
      ) : null}
      </Presence>

      {/*
        AND ONCE HE IS INSIDE, THE VISIT FOLLOWS HIM TOO.
        A check-in is not a screen. He opens the customer's statement, punches
        an order, looks up a price — and the visit he is in carries on, clock
        and all, until he checks out. The clock is measured from the check-in
        instant ON DISK (`arrival.checkedInAt`), so nothing about where he is in
        the app, or whether Android reaped it, can stop it. Tapping the bar is
        the way back to the check-out.
      */}
      <Presence show={!!arrival && arrival.checkedInAt != null && here !== 'visit'} distance={12}>
      {arrival && arrival.checkedInAt != null && here !== 'visit' ? (
        <InVisitBar
          name={arrival.customerName}
          since={arrival.checkedInAt}
          leftAt={arrival.leftShopAt ?? null}
          onPress={() => {
            set({ custId: arrival.customerId });
            router.push('/visit');
          }}
        />
      ) : null}
      </Presence>
      </View>

      {/*
        NO PUNCH-OUT BAR ON OTHER SCREENS. One sat above the tab bar on every
        screen from the prompt hour, and that is exactly where a thumb reaching
        for a tab lands — a misclick there opens the camera to end somebody's
        day. Punching out is the main button on Home in the evening, and the
        reminder notification opens Home at it (`?punchOut=1`).
      */}

      {/* Measured rather than guessed, so the toast can sit above whatever the
          screen pinned here — see `Toast`. A screen with no footer measures 0
          and nothing moves. */}
      {footer ? (
        /* The tab bar it now replaces is what kept the bottom of the screen
           clear of the gesture bar, so the action bar carries that inset
           itself — on the same white as the bars it sits on. */
        <View
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
          style={{ backgroundColor: footerBg ?? C.surface }}>
          {footer}
          {keyboardHeight === 0 && insets.bottom > 0 ? (
            <View style={{ height: insets.bottom, backgroundColor: footerInsetBg ?? footerBg ?? C.surface }} />
          ) : null}
        </View>
      ) : null}

      {/* The tab bar is hidden while typing. Left in place it floats over the
          keyboard on Android, covering the top row of keys.

          AND ON A SCREEN WITH ITS OWN ACTION BAR. Picking a day's shops and a
          visit pin their one decision to the bottom, and the tab bar's raised
          + sat on top of it — over "Not now" on the shop picker, so a thumb
          meant for one landed on the other — and the two bars together left
          room for two and a half shops. Those screens are a task with a way
          back at the top; the tabs return the moment he leaves. */}
      {showsTabBar ? (
        <>
          <TabBar
            active={activeTab}
            bottomInset={insets.bottom}
            /* BACK to a tab rather than another copy of it on top. `dismissTo`
               pops to it where it is already in the stack and replaces this
               screen with it where it is not — so the stack never holds Home
               twice, and Android's Back from a tab leaves the app. */
            onTab={(k) => router.dismissTo(`/${k}`)}
            /* The office proposes a day and waits on the answer to plan a week.
               The Journey screen has always listed those days at the top; what
               it could not do was say so from anywhere else in the app, so being
               asked and never noticing looked identical to having no plan. */
            badges={{ journey: daysToAgree }}
          />
          {/* Beside the bar rather than inside it, because it is taller than
              the bar is — see `TabBarAction`. Same pixel, same behaviour, and
              it no longer depends on a renderer being willing to hit-test
              outside a parent's bounds. */}
          <TabBarAction bottomInset={insets.bottom} onPress={() => set({ sheet: 'action' })} />
        </>
      ) : null}

      <ActionSheet
        open={sheet === 'action'}
        title="What are you doing?"
        items={actionItems}
        layout="quick"
        onClose={() => set({ sheet: null })}
      />

      <ConfirmSheet
        open={!!confirm}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        reasonLabel={confirm?.reasonLabel}
        confirmLabel={confirm?.confirmLabel ?? ''}
        cancelLabel={confirm?.cancelLabel}
        tone={confirm?.tone}
        placeholder={confirm?.placeholder}
        subtitle={confirm?.subtitle}
        lead={confirm?.lead}
        reason={confirmReason}
        onReason={(v) => set({ confirmReason: v, confirmErr: false })}
        error={confirmErr}
        onCancel={closeConfirm}
        onConfirm={() => {
          /* Read from the store, not the render: a second tap arrives before
             the re-render that clears `confirm`, and ran the action twice —
             two receipts for one payment. Closed BEFORE it runs, so the second
             tap finds nothing, and an action that opens the next dialog is not
             closed by this one. */
          const live = useStore.getState().confirm;
          if (!live) return;
          const r = useStore.getState().confirmReason.trim();
          /* A reason that was asked for and not given stops the action, not the dialog. */
          if (live.reasonLabel && !r) {
            feedback('warning');
            return set({ confirmErr: true });
          }
          closeConfirm();
          live.run(r);
        }}
      />

      {/* Mounted HERE, once, because every screen is inside an AppFrame and
          four of them start visits. A gate each screen wired up for itself
          would be four gates, and three of them would be right. */}
      <TravelGate />

      {topSheet == null ? <StoreToast lift={footerHeight} /> : null}
    </View>
  );
}

/**
 * "You are at Shah Paints — check in." One line, one tap, every screen.
 *
 * Drawn in the app's own primary colour rather than as a warning, because
 * arriving and not yet going in is ordinary — he is parking, or the owner is
 * out the back — and an amber bar for the ordinary case is how a colour stops
 * meaning anything. The time is on it so he can tell this morning's forgotten
 * arrival from the one he made ninety seconds ago.
 */
function ArrivedBar({ name, at, onPress }: { name: string; at: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Check in at ${name}, arrived ${hhmm(at)}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 60,
        paddingLeft: 16,
        paddingRight: 8,
        paddingVertical: 8,
        borderRadius: 22,
        backgroundColor: pressed ? C.primaryDeep : C.primary,
        boxShadow: '0 12px 28px -10px rgba(104,53,251,0.6)',
      })}>
      <Icon name="shop" size={20} color="#FFFFFF" strokeWidth={2} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[{ fontSize: 15, color: '#FFFFFF' }, weight(700)]}>
          {'At ' + name}
        </Text>
        <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: 'rgba(255,255,255,0.85)' }}>
          {'Arrived ' + hhmm(at) + ' · not checked in'}
        </Text>
      </View>
      <View style={{ flexShrink: 0, minHeight: 44, paddingVertical: 6, paddingHorizontal: 16, borderRadius: 22, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[{ fontSize: 14, lineHeight: 20, color: C.navy }, weight(700)]}>Check in</Text>
      </View>
    </Pressable>
  );
}

/**
 * "In Shah Paints · 12m 30s — Check out." The running visit, on every screen.
 *
 * The clock ticks every second while the app is in front and is corrected the
 * moment it comes back (`useTicker`), because the figure is a subtraction from
 * the check-in instant rather than a counter — there is nothing to pause.
 */
function InVisitBar({
  name,
  since,
  leftAt,
  onPress,
}: {
  name: string;
  since: number;
  /** When the trail saw him walk away without checking out. The clock stops there. */
  leftAt: number | null;
  onPress: () => void;
}) {
  const now = useTicker(1_000);
  const spent = elapsedLabel(Math.max(0, Math.floor(((leftAt ?? now) - since) / 1000)));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`In a visit at ${name} for ${spent}. Go back to it to check out.`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 60,
        paddingLeft: 16,
        paddingRight: 8,
        paddingVertical: 8,
        borderRadius: 22,
        backgroundColor: pressed ? C.primaryDeep : C.primary,
        boxShadow: '0 12px 28px -10px rgba(104,53,251,0.6)',
      })}>
      <Icon name="shop" size={20} color="#FFFFFF" strokeWidth={2} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[{ fontSize: 15, color: '#FFFFFF' }, weight(700)]}>
          {(leftAt != null ? 'You left ' : 'In ') + name}
        </Text>
        <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: 'rgba(255,255,255,0.85)' }}>
          {leftAt != null
            ? 'Not checked out · left about ' + hhmm(leftAt)
            : 'Checked in ' + hhmm(since) + ' · ' + spent}
        </Text>
      </View>
      <View style={{ flexShrink: 0, minHeight: 44, paddingVertical: 6, paddingHorizontal: 16, borderRadius: 22, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[{ fontSize: 14, lineHeight: 20, color: C.navy }, weight(700)]}>Check out</Text>
      </View>
    </Pressable>
  );
}

/**
 * The day as the frame needs it: when it started, whether a session is open,
 * and the sessions behind it.
 *
 * From the attendance row rather than from a flag. The strip is on every
 * screen including the ones opened after a restart, so a boolean held in
 * memory would read "Not checked in" to somebody who has been working since
 * nine.
 */
function useDayClock(): { checkInAt: number | null; sessions: Session[] } {
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;
  const [state, setState] = React.useState<{ checkInAt: number | null; sessions: Session[] }>({
    checkInAt: null,
    sessions: [],
  });

  React.useEffect(() => {
    let live = true;
    /* Nothing to read without a session, and nothing to clear either — the
       frame is unmounted the moment somebody signs out. */
    if (!userId) return;
    const tick = () => {
      void dayState(userId)
        .then((day) => {
          if (!live) return;
          setState({ checkInAt: day.firstInAt, sessions: day.sessions });
        })
        /* A status read may not break a screen; the next tick tries again. */
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [userId]);

  return state;
}


/** The empty-state card the design reuses for anything not built yet. */
export function StubCard({ title, body }: { title: string; body: string }) {
  return (
    <View style={s.stub}>
      <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink, textAlign: 'center' }, weight(600)]}>{title}</Text>
      <Text style={[type.small, { color: C.muted, textAlign: 'center', marginTop: 8 }]}>{body}</Text>
    </View>
  );
}

export { plural };

const s = StyleSheet.create({
  chrome: { backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.hairline },
  stub: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: 16,
    boxShadow: '0 1px 2px rgba(22,22,22,0.04), 0 8px 24px -12px rgba(22,22,22,0.10)',
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
});
