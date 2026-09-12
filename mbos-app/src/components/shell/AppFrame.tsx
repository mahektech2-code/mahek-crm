import React from 'react';
import { View, Text, Pressable, Platform, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, usePathname } from 'expo-router';
import { color as C, type, weight } from '../../theme/tokens';
import { Header, StatusStrip, TabBar, TabBarAction, type StripTone, type TabKey } from './Chrome';
import { ActionSheet, ConfirmSheet, Toast } from '../ui/overlays';
import { useKeyboardHeight } from '../ui/keyboard';
import { useTicker } from '../ui/use-ticker';
import { Appear } from '../ui/motion';
import { useCustomer, useDaysToAgreeCount, usePendingCount, useStore, useUnreadCount } from '../../state/store';
import { TravelGate } from './TravelGate';
import { useBoot } from '../../state/boot';
import { todayRow } from '../../data/attendance';
import { plural } from '../../lib/format';
import { gpsVerdict, type GpsHealth } from '../../engines/gps-health';
import { gpsSignal } from '../../native/where';
import { hasPermission } from '../../native/location';
import { getConfig } from '../../data/config';

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
  customer: 'Customer',
  visit: 'Visit',
  order: 'Order',
  pay: 'Payment',
  tasks: 'Tasks',
  samples: 'Samples',
  sync: 'Sync',
  attendance: 'Attendance',
  leave: 'Leave',
  salary: 'Salary',
  expenses: 'Expenses',
  performance: 'Performance',
  catalogue: 'Catalogue',
  docs: 'Documents',
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
};

/** Reads the recorded entry route, so the label and the destination agree. */
export function useCameFrom(fallback = 'more') {
  const params = useLocalSearchParams<{ from?: string }>();
  const from = params.from || fallback;
  return {
    from,
    label: FROM_LABEL[from] ?? from.charAt(0).toUpperCase() + from.slice(1),
    go: () => router.replace(`/${from === 'home' ? 'home' : from}`),
  };
}

/** The inline "‹ More" link the design puts at the top of every sub-screen. */
export function BackLink({ label, onPress }: { label: string; onPress: () => void }) {
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
      <Text style={{ fontSize: 18, lineHeight: 18, color: C.muted }}>‹</Text>
      <Text style={{ fontSize: 15, color: C.muted }}>{label}</Text>
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
  children,
}: {
  title: string;
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
  const fromHere = `?from=${here}`;
  const keyboardHeight = useKeyboardHeight();
  const [footerHeight, setFooterHeight] = React.useState(0);
  const unread = useUnreadCount();
  const waiting = usePendingCount();
  const daysToAgree = useDaysToAgreeCount();
  const checkInAt = useCheckInTime();
  const checkedIn = checkInAt != null;
  /* From the radio, not from `store.gps` — see `useGpsHealth` above, and
     `engines/gps-health.ts` for why that field cannot answer this question. */
  const gps = useGpsHealth();
  const toast = useStore((s) => s.toast);
  const toastTone = useStore((s) => s.toastTone);
  const clearToast = useStore((s) => s.clearToast);
  const sheet = useStore((s) => s.sheet);
  const set = useStore((s) => s.set);
  const askTravel = useStore((s) => s.askTravel);
  const customer = useCustomer();
  const notify = useStore((s) => s.notify);
  const custId = useStore((s) => s.custId);
  const confirm = useStore((s) => s.confirm);
  const confirmReason = useStore((s) => s.confirmReason);
  const confirmErr = useStore((s) => s.confirmErr);
  const closeConfirm = useStore((s) => s.closeConfirm);

  const strip: { key: string; label: string; tone: StripTone; onPress: () => void }[] = [
    {
      key: 'att',
      /*
       * SHORT ENOUGH FOR THE CELL IT HAS.
       *
       * Three cells share the width: on a 360pt handset each gets about 117,
       * less 16 of padding, less the dot and its gap, which leaves roughly 88
       * for the text. "Not checked in" and "In since 09:12" both measure about
       * that at 12pt, so the one fact somebody looks for first thing in the
       * morning rendered as "Not checked i…". These fit with room to spare.
       */
      label: checkInAt != null ? 'In ' + hhmm(checkInAt) : 'Not in',
      tone: checkedIn ? 'ok' : 'idle',
      onPress: () => router.push(`/attendance${fromHere}`),
    },
    {
      key: 'gps',
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
      label: waiting === 0 ? 'All sent' : `${waiting} waiting`,
      tone: waiting === 0 ? 'ok' : 'warn',
      onPress: () => router.push(`/sync${fromHere}`),
    },
  ];

  const actionItems = [
    /* It asks how he is getting there BEFORE the visit opens — see
       `TravelGate`. The sub-line says so, because a quick action that raises a
       question rather than the screen it names reads as the wrong button. */
    {
      glyph: 'visit',
      label: 'Start visit',
      sub: 'How you travel, then GPS and photos',
      run: () => {
        if (!custId) return notify('Choose the shop first, then start the visit.');
        askTravel({ customerId: custId, customerName: customer?.name ?? 'this shop' });
      },
    },
    { glyph: 'order', label: 'Punch order', sub: 'From their usual products', run: () => router.push(`/order${fromHere}`) },
    { glyph: 'money', label: 'Collect payment', sub: 'Cash, cheque, UPI or transfer', run: () => router.push(`/pay${fromHere}`) },
    /* The form is asked for here and opened by the Leads screen, so the shop
       he is standing outside is typed in rather than found for a second time. */
    { glyph: 'add', label: 'Add lead', sub: 'A shop you just walked past', run: () => { set({ sheet: 'leadForm' }); router.push(`/leads${fromHere}`); } },
    { glyph: 'camera', label: 'Log expense', sub: 'Photograph the bill', run: () => router.push(`/expenses${fromHere}`) },
    { glyph: 'task', label: 'Create task', sub: 'For you or for someone else', run: () => router.push(`/tasks${fromHere}`) },
    { glyph: 'sample', label: 'Request sample', sub: 'Sent for approval', run: () => router.push(`/samples${fromHere}`) },
  ];

  /**
   * The scroll area lifts by exactly the keyboard's height.
   *
   * `automaticallyAdjustKeyboardInsets` does this on iOS on its own; Android
   * runs edge-to-edge here, so its window does not resize and the padding has
   * to be applied by hand or the field being typed into sits behind the keys.
   */
  const body = scroll ? (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[contentStyle, keyboardHeight > 0 && { paddingBottom: keyboardHeight + 24 }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      showsVerticalScrollIndicator={false}>
      {/* The quieter half of the transition: the screen has arrived, and this
          is it settling. It also covers the frame or two where SQLite has not
          answered yet, so data reads as arriving rather than popping in. */}
      <Appear>{children}</Appear>
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, contentStyle]}>
      <Appear style={{ flex: 1 }}>{children}</Appear>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.canvas, paddingTop: insets.top }}>
      <View style={s.chrome}>
        <Header
          title={title}
          onBack={onBack}
          unread={unread}
          /* No bell on the notifications screen. A control whose whole job is
             to bring you here is furniture once you have arrived, and tapping
             it stacked a second copy of the page. */
          onBell={here === 'notifications' ? undefined : () => router.push(`/notifications${fromHere}`)}
        />
        <StatusStrip items={strip} />
      </View>

      {body}

      {/* Measured rather than guessed, so the toast can sit above whatever the
          screen pinned here — see `Toast`. A screen with no footer measures 0
          and nothing moves. */}
      {footer ? (
        <View onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}>{footer}</View>
      ) : null}

      {/* The tab bar is hidden while typing. Left in place it floats over the
          keyboard on Android, covering the top row of keys. */}
      {keyboardHeight === 0 ? (
        <>
          <TabBar
            active={activeTab}
            bottomInset={insets.bottom}
            onTab={(k) => router.replace(`/${k}`)}
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
        onClose={() => set({ sheet: null })}
      />

      <ConfirmSheet
        open={!!confirm}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        reasonLabel={confirm?.reasonLabel}
        confirmLabel={confirm?.confirmLabel ?? ''}
        reason={confirmReason}
        onReason={(v) => set({ confirmReason: v, confirmErr: false })}
        error={confirmErr}
        onCancel={closeConfirm}
        onConfirm={() => {
          if (!confirm) return;
          const r = confirmReason.trim();
          /* A reason that was asked for and not given stops the action, not the dialog. */
          if (confirm.reasonLabel && !r) return set({ confirmErr: true });
          confirm.run(r);
          closeConfirm();
        }}
      />

      {/* Mounted HERE, once, because every screen is inside an AppFrame and
          four of them start visits. A gate each screen wired up for itself
          would be four gates, and three of them would be right. */}
      <TravelGate />

      <Toast message={toast} tone={toastTone} onDone={clearToast} lift={footerHeight} />
    </View>
  );
}

/**
 * When the day started, from the attendance row rather than from a flag.
 *
 * The strip is on every screen including the ones opened after a restart, so a
 * boolean held in memory would read "Not checked in" to somebody who has been
 * working since nine.
 */
function useCheckInTime(): number | null {
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;
  const [at, setAt] = React.useState<number | null>(null);

  React.useEffect(() => {
    let live = true;
    /* Nothing to read without a session, and nothing to clear either — the
       frame is unmounted the moment somebody signs out. */
    if (!userId) return;
    const tick = () => {
      void todayRow(userId).then((row) => {
        if (live) setAt(row?.checkInAt ?? null);
      });
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [userId]);

  return at;
}

/** 09:12, in the handset's own zone — the only place the strip formats a time. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** The empty-state card the design reuses for anything not built yet. */
export function StubCard({ title, body }: { title: string; body: string }) {
  return (
    <View style={s.stub}>
      <Text style={[{ fontSize: 15, color: C.ink, textAlign: 'center' }, weight(600)]}>{title}</Text>
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
