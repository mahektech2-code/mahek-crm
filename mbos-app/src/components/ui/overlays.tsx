import React from 'react';
import { Animated, Easing, View, Text, Pressable, Modal, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { color as C, HIT, radius, shadow, type, weight, tabular } from '../../theme/tokens';
import { Icon } from './Icon';
import { Input, PrimaryButton, SecondaryButton } from './primitives';
import { isoDate, monthName } from '../../lib/format';
import { useKeyboardHeight } from './keyboard';
import { useReduceMotion } from './motion';

/**
 * Everything that floats above a screen. All of it goes through `Modal` so it
 * sits above the tab bar and takes the hardware back button on Android — a
 * sheet you cannot dismiss with Back is a sheet people force-quit the app to
 * escape.
 */

/* ------------------------------------------------------------------ scrim */

function Scrim({
  onPress,
  children,
  align = 'flex-end',
  tone = 'dark',
}: {
  onPress: () => void;
  children: React.ReactNode;
  align?: 'flex-end' | 'center';
  tone?: 'dark' | 'light';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        backgroundColor: tone === 'dark' ? C.scrim : C.scrimLight,
        justifyContent: align,
        paddingHorizontal: align === 'center' ? 20 : 0,
      }}>
      {/* Swallowing the press is what keeps a tap inside the sheet from closing it. */}
      <Pressable onPress={(e) => e.stopPropagation()} style={align === 'center' ? { width: '100%', maxWidth: 320, alignSelf: 'center' } : undefined}>
        {children}
      </Pressable>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ toast */

/**
 * The toast.
 *
 * It rises rather than appears, because it is confirming something the person
 * just did and a thing that fades UP from where their thumb was reads as
 * caused by them. It leaves the same way instead of blinking out, which is
 * what stops it feeling like a glitch on a slow frame.
 */
export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  const reduce = useReduceMotion();
  const progress = React.useRef(new Animated.Value(0)).current;
  const [showing, setShowing] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (message) setShowing(message);
  }, [message]);

  React.useEffect(() => {
    if (!message) return;

    if (reduce) {
      progress.setValue(1);
      const t = setTimeout(onDone, 2600);
      return () => clearTimeout(t);
    }

    const enter = Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      easing: Easing.bezier(0.2, 0, 0.2, 1),
      useNativeDriver: true,
    });
    enter.start();

    /* Leave BEFORE telling the store, so the exit is seen rather than cut off
       by the message being cleared out from under it. */
    const t = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: 160,
        easing: Easing.bezier(0.2, 0, 0.2, 1),
        useNativeDriver: true,
      }).start(() => {
        setShowing(null);
        onDone();
      });
    }, 2400);

    return () => {
      enter.stop();
      clearTimeout(t);
    };
  }, [message, onDone, progress, reduce]);

  if (!showing) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        st.toast,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}>
      <View style={st.toastTick}>
        <Icon name="tick" size={14} color={C.lime} strokeWidth={2.6} />
      </View>
      <Text style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(500)]}>{showing}</Text>
    </Animated.View>
  );
}

/* ------------------------------------------------------------- bottom sheet */

export function BottomSheet({
  open,
  onClose,
  children,
  scroll = false,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  scroll?: boolean;
}) {
  const keyboardHeight = useKeyboardHeight();
  const { height: screenHeight } = useWindowDimensions();

  /**
   * The sheet sits ON the keyboard, on BOTH platforms.
   *
   * The first attempt lifted it on iOS and added padding INSIDE it on Android,
   * which was the wrong lever entirely: padding makes the sheet taller without
   * moving its bottom edge, so the form grew downwards and the field being
   * typed into stayed behind the keys. The sheet has to MOVE.
   *
   * `marginBottom` does it, because the scrim aligns to `flex-end` — pushing
   * the bottom edge up by exactly the keyboard's height puts the whole sheet
   * above it. Android needs this more than iOS, since an edge-to-edge window
   * never resizes for the keyboard at all.
   *
   * These sheets are where the writing happens — the reason for a leave
   * request, what the customer actually said about a complaint — so a field
   * behind the keyboard is the form being unusable, not merely awkward.
   */
  const available = Math.max(200, screenHeight - keyboardHeight - 80);
  const pad = { padding: 20, paddingBottom: 24 };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Scrim onPress={onClose}>
        <View style={[st.sheet, keyboardHeight > 0 && { marginBottom: keyboardHeight }]}>
          {scroll ? (
            <ScrollView
              style={{ maxHeight: available }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              showsVerticalScrollIndicator={false}>
              <View style={pad}>{children}</View>
            </ScrollView>
          ) : (
            <ScrollView
              style={{ maxHeight: available }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              <View style={pad}>{children}</View>
            </ScrollView>
          )}
        </View>
      </Scrim>
    </Modal>
  );
}

/** The grabber-and-list sheet the FAB and the row overflow both open. */
export function ActionSheet({
  open,
  title,
  items,
  onClose,
}: {
  open: boolean;
  title: string;
  items: { glyph: string; label: string; sub: string; run: () => void }[];
  onClose: () => void;
}) {
  const keyboardHeight = useKeyboardHeight();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Scrim onPress={onClose}>
        <View style={[st.sheet, keyboardHeight > 0 && { marginBottom: keyboardHeight }, { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, paddingTop: 8, paddingBottom: 24, boxShadow: shadow.sheet }]}>
          <View style={st.grabber} />
          <Text style={[{ fontSize: 15, color: C.ink, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }, weight(600)]}>
            {title}
          </Text>
          {items.map((i) => (
            <Pressable
              key={i.label}
              onPress={() => {
                onClose();
                i.run();
              }}
              style={({ pressed }) => [st.sheetRow, pressed && { backgroundColor: C.wash }]}>
              <View style={st.sheetGlyph}>
                <Icon name={i.glyph} size={18} color={C.body} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{i.label}</Text>
                <Text style={type.caption}>{i.sub}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </Scrim>
    </Modal>
  );
}

/* ---------------------------------------------------------------- confirm */

/**
 * The one dialog in the app that can demand a reason.
 *
 * Every destructive or off-plan action here — saving an unverified visit,
 * adding a stop nobody planned, pushing a task back, asking for an attendance
 * correction — is allowed. What it is not is silent: the reason is required,
 * and the copy says who reads it.
 */
export function ConfirmSheet({
  open,
  title,
  body,
  reasonLabel,
  confirmLabel,
  reason,
  onReason,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  reasonLabel?: string;
  confirmLabel: string;
  reason: string;
  onReason: (v: string) => void;
  error: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <BottomSheet open={open} onClose={onCancel}>
      <Text style={[type.h2, { letterSpacing: -0.285 }]}>{title}</Text>
      <Text style={[type.body, { marginTop: 6 }]}>{body}</Text>
      {reasonLabel ? (
        <View style={{ marginTop: 14 }}>
          <Text style={[type.label, { marginBottom: 6 }]}>{reasonLabel}</Text>
          <Input
            value={reason}
            onChangeText={onReason}
            multiline
            invalid={error}
            placeholder="Tell your manager what happened"
            style={{ minHeight: 80, borderRadius: radius.md, fontSize: 15 }}
          />
          {error ? <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>A reason is required.</Text> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <SecondaryButton label="Cancel" onPress={onCancel} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton label={confirmLabel} onPress={onConfirm} tone="warn" style={{ flex: 1, borderRadius: radius.xl }} />
      </View>
    </BottomSheet>
  );
}

/* --------------------------------------------------------------- calendar */

export type CalendarProps = {
  /** ISO day currently chosen, or '' for none. */
  selected: string;
  onPick: (iso: string) => void;
  /** Shades the days between two ISO dates, for a leave range. */
  rangeFrom?: string;
  rangeTo?: string;
  /** Returning a sentence refuses the day and says why. */
  disabledReason?: (iso: string) => string | null;
  /** Six full weeks keeps the sheet from resizing as months change. */
  fixedWeeks?: boolean;
};

export function Calendar({ selected, onPick, rangeFrom, rangeTo, disabledReason, fixedWeeks = true }: CalendarProps) {
  const today = React.useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const [offset, setOffset] = React.useState(0);
  const shown = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const todayIso = isoDate(today);

  /* Weeks start on Monday, which is how a working week is read here. */
  const lead = (shown.getDay() + 6) % 7;
  const cells: (Date | null)[] = [];
  if (fixedWeeks) {
    const first = new Date(shown);
    first.setDate(1 - lead);
    for (let i = 0; i < 42; i++) {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      cells.push(d);
    }
  } else {
    for (let i = 0; i < lead; i++) cells.push(null);
    const total = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= total; d++) cells.push(new Date(shown.getFullYear(), shown.getMonth(), d));
  }

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable onPress={() => setOffset(offset - 1)} accessibilityLabel="Previous month" style={st.calNav}>
          <Text style={{ fontSize: 20, color: C.body }}>‹</Text>
        </Pressable>
        <Text style={[{ flex: 1, textAlign: 'center', fontSize: 16, color: C.ink }, weight(600)]}>
          {monthName(shown.getMonth()) + ' ' + shown.getFullYear()}
        </Text>
        <Pressable onPress={() => setOffset(offset + 1)} accessibilityLabel="Next month" style={st.calNav}>
          <Text style={{ fontSize: 20, color: C.body }}>›</Text>
        </Pressable>
      </View>

      <View style={{ flexDirection: 'row', marginTop: 4 }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <Text key={i} style={[{ flex: 1, height: 28, textAlign: 'center', lineHeight: 28, fontSize: 12, color: C.muted }, weight(600)]}>
            {d}
          </Text>
        ))}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((d, i) => {
          if (!d) return <View key={i} style={{ width: `${100 / 7}%`, height: 44 }} />;
          const key = isoDate(d);
          const inMonth = d.getMonth() === shown.getMonth();
          const isToday = key === todayIso;
          const picked = key === selected;
          const between = !!rangeFrom && !!rangeTo && key > rangeFrom && key < rangeTo;
          const refusal = disabledReason ? disabledReason(key) : null;
          const off = !!refusal;
          return (
            <Pressable
              key={i}
              onPress={() => !off && onPick(key)}
              disabled={off}
              accessibilityRole="button"
              accessibilityState={{ selected: picked, disabled: off }}
              style={{
                width: `${100 / 7}%`,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: between && !picked ? 0 : radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: picked ? C.primary : between ? C.primaryTint : 'transparent',
                  borderWidth: isToday && !picked ? 1 : 0,
                  borderColor: C.primaryEdge,
                }}>
                <Text
                  style={[
                    {
                      fontSize: 15,
                      color: picked ? '#FFFFFF' : off || !inMonth ? C.faint : isToday ? C.primaryDeep : C.ink,
                    },
                    weight(picked || isToday ? 600 : 400),
                    tabular,
                  ]}>
                  {d.getDate()}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  sheet: {
    width: '100%',
    backgroundColor: C.surface,
    borderTopLeftRadius: radius.sheetTall,
    borderTopRightRadius: radius.sheetTall,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: 'center',
    marginVertical: 6,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    height: 60,
    paddingHorizontal: 16,
  },
  sheetGlyph: {
    width: HIT,
    height: HIT,
    borderRadius: radius.sm,
    backgroundColor: C.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calNav: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 88,
    zIndex: 50,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: C.primaryDark,
    borderRadius: radius.xl,
    paddingHorizontal: 16,
    paddingVertical: 14,
    boxShadow: shadow.toast,
  },
  toastTick: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(198,255,52,0.20)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
});
