import React from 'react';
import { Animated, Easing, View, Text, Pressable, Modal, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { color as C, HIT, radius, shadow, type, weight, tabular } from '../../theme/tokens';
import { Icon } from './Icon';
import { Input, PrimaryButton, SecondaryButton } from './primitives';
import { isoDate, monthName } from '../../lib/format';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_HEIGHT } from '../shell/Chrome';
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
 *
 * And it is CLEAR of the furniture underneath it. `bottom: 88` was a
 * hardcoded guess at the tab bar's height — which is
 * `64 + insets.bottom`, so on any handset with a gesture bar the toast landed
 * exactly ON the bar with nothing between them, and the raised action button
 * (which pokes 20 points above it) sat over the text. What it actually looked
 * like on a phone was a toast growing out of the tab bar and covering the last
 * row of whatever list was open.
 *
 * Measured rather than guessed, and the same arithmetic `TabBar` itself uses.
 * `lift` is for a screen with a pinned footer of its own — the pick screen's
 * save bar — because a message about what just happened must not cover the
 * button that did it.
 *
 * AND IT HAS A TONE, because this is the app's only error channel and it was
 * drawing every one of them under a green tick. "No number on this customer",
 * "that shop is billed to somebody who is not on your book", "the ticket could
 * not be added just now" — all refusals, all confirmed with the same lime tick
 * a saved order gets. A refusal somebody half-read, marked with a tick, reads
 * as a confirmation, and he walks away from the shop believing it went.
 *
 * A `warn` toast therefore differs in three ways and each of them earns its
 * place: the glyph is the refusal one rather than the tick, it stays on screen
 * longer because a sentence explaining what went wrong is longer than "Saved",
 * and it can be TAPPED away — which also means it is the one toast that takes
 * touches at all, so it is never left `pointerEvents="none"` over a button the
 * person is trying to press.
 */
export type ToastTone = 'success' | 'warn';

/* How long each tone sits there. A refusal is a sentence to read; a
   confirmation is a word to glimpse. */
const DWELL: Record<ToastTone, number> = { success: 2400, warn: 5200 };

export function Toast({
  message,
  onDone,
  lift = 0,
  /** Defaults to the confirmation this has always drawn, so no caller has to change. */
  tone = 'success',
}: {
  message: string | null;
  onDone: () => void;
  lift?: number;
  tone?: ToastTone;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const progress = React.useRef(new Animated.Value(0)).current;
  const [showing, setShowing] = React.useState<string | null>(null);
  const warn = tone === 'warn';

  React.useEffect(() => {
    if (message) setShowing(message);
  }, [message]);

  /* ONE way out, whether it is the timer or a thumb that ends it. Held apart
     from the effect below because a tap has to be able to run it too, and two
     copies of "animate out, then tell the store" is how one of them forgets to
     clear `showing` — which is exactly what the reduce-motion path did, leaving
     the pill on screen for good. */
  const leave = React.useCallback(() => {
    if (reduce) {
      progress.setValue(0);
      setShowing(null);
      onDone();
      return;
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: 160,
      easing: Easing.bezier(0.2, 0, 0.2, 1),
      useNativeDriver: true,
    }).start(() => {
      setShowing(null);
      onDone();
    });
  }, [onDone, progress, reduce]);

  React.useEffect(() => {
    if (!message) return;
    const dwell = DWELL[tone];

    if (reduce) {
      progress.setValue(1);
      const t = setTimeout(leave, dwell);
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
    const t = setTimeout(leave, dwell);

    return () => {
      enter.stop();
      clearTimeout(t);
    };
  }, [message, tone, leave, progress, reduce]);

  if (!showing) return null;
  return (
    <Animated.View
      /* Only a refusal takes touches, and only so it can be dismissed. A
         confirmation that could swallow a tap would be covering the next thing
         somebody meant to press. */
      pointerEvents={warn ? 'box-none' : 'none'}
      style={[
        st.toast,
        {
          bottom: TAB_BAR_HEIGHT + insets.bottom + 12 + lift,
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}>
      <Pressable
        onPress={warn ? leave : undefined}
        disabled={!warn}
        accessibilityRole={warn ? 'button' : undefined}
        accessibilityLabel={warn ? showing + '. Tap to dismiss.' : undefined}
        style={st.toastBody}>
        <View style={[st.toastChip, warn && st.toastChipWarn]}>
          <Icon name={warn ? 'alert' : 'tick'} size={14} color={warn ? C.warn : C.lime} strokeWidth={2.6} />
        </View>
        <Text style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(500)]}>{showing}</Text>
      </Pressable>
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
    /* `bottom` is set on the element — see the note on `Toast`. */
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
  /* The row inside the pill. It is its own element because a warn toast is
     PRESSABLE — a refusal somebody half-read should be dismissable rather than
     expiring on a fixed timer — and the press target has to be the whole row,
     not the pill's padding. */
  toastBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  toastChip: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(198,255,52,0.20)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  /* A REFUSAL IS NOT A CONFIRMATION. `notify()` is the app's only error
     channel, and every message it carried — "No number on this customer",
     "…is billed to somebody who is not on your book" — arrived under a green
     tick. A refusal marked with a tick reads as the opposite of itself. */
  toastChipWarn: {
    backgroundColor: 'rgba(183,123,8,0.22)',
  },
});
