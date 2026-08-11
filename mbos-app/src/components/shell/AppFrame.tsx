import React from 'react';
import { View, Text, Pressable, Platform, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { color as C, type, weight } from '../../theme/tokens';
import { Header, StatusStrip, TabBar, type StripTone, type TabKey } from './Chrome';
import { ActionSheet, ConfirmSheet, Toast } from '../ui/overlays';
import { useKeyboardHeight } from '../ui/keyboard';
import { Appear } from '../ui/motion';
import { usePendingCount, useStore, useUnreadCount } from '../../state/store';
import { useBoot } from '../../state/boot';
import { todayRow } from '../../data/attendance';
import { plural } from '../../lib/format';

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
  const keyboardHeight = useKeyboardHeight();
  const unread = useUnreadCount();
  const waiting = usePendingCount();
  const checkInAt = useCheckInTime();
  const checkedIn = checkInAt != null;
  const gps = useStore((s) => s.gps);
  const toast = useStore((s) => s.toast);
  const clearToast = useStore((s) => s.clearToast);
  const sheet = useStore((s) => s.sheet);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const beginVisit = useStore((s) => s.beginVisit);
  const custId = useStore((s) => s.custId);
  const confirm = useStore((s) => s.confirm);
  const confirmReason = useStore((s) => s.confirmReason);
  const confirmErr = useStore((s) => s.confirmErr);
  const closeConfirm = useStore((s) => s.closeConfirm);

  const strip: { key: string; label: string; tone: StripTone; onPress: () => void }[] = [
    {
      key: 'att',
      label: checkInAt != null ? 'In since ' + hhmm(checkInAt) : 'Not checked in',
      tone: checkedIn ? 'ok' : 'idle',
      onPress: () => router.push('/attendance?from=home'),
    },
    {
      key: 'gps',
      label: gps === 'locked' ? 'GPS locked' : gps === 'off' ? 'GPS off' : 'Finding GPS',
      tone: gps === 'locked' ? 'ok' : gps === 'off' ? 'warn' : 'idle',
      onPress: () => router.push('/home'),
    },
    {
      key: 'sync',
      label: `${waiting} to send`,
      tone: 'warn',
      onPress: () => router.push('/sync?from=home'),
    },
  ];

  const actionItems = [
    { glyph: 'visit', label: 'Start visit', sub: 'GPS, photos, voice note', run: () => { beginVisit(custId); router.push('/visit'); } },
    { glyph: 'order', label: 'Punch order', sub: 'From their usual products', run: () => router.push('/order?from=home') },
    { glyph: 'money', label: 'Collect payment', sub: 'Cash, cheque, UPI or transfer', run: () => router.push('/pay?from=home') },
    { glyph: 'add', label: 'Add lead', sub: 'A shop you just walked past', run: () => notify('New lead') },
    { glyph: 'camera', label: 'Log expense', sub: 'Photograph the bill', run: () => router.push('/expenses?from=home') },
    { glyph: 'task', label: 'Create task', sub: 'For you or for someone else', run: () => router.push('/tasks?from=home') },
    { glyph: 'sample', label: 'Request sample', sub: 'Sent for approval', run: () => router.push('/samples?from=home') },
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
        <Header title={title} onBack={onBack} unread={unread} onBell={() => router.push('/notifications?from=home')} />
        <StatusStrip items={strip} />
      </View>

      {body}

      {footer}

      {/* The tab bar is hidden while typing. Left in place it floats over the
          keyboard on Android, covering the top row of keys. */}
      {keyboardHeight === 0 ? (
        <TabBar
          active={activeTab}
          bottomInset={insets.bottom}
          onTab={(k) => router.replace(`/${k}`)}
          onAction={() => set({ sheet: 'action' })}
        />
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

      <Toast message={toast} onDone={clearToast} />
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
