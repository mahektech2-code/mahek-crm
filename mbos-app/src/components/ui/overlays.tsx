import React from 'react';
import { Animated, Easing, View, Text, Pressable, Modal, PanResponder, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { color as C, HIT, radius, shadow, type, weight, tabular } from '../../theme/tokens';
import { Icon } from './Icon';
import { Input, PrimaryButton, SecondaryButton } from './primitives';
import { isoDate, monthName } from '../../lib/format';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_HEIGHT } from '../shell/Chrome';
import { useKeyboardHeight } from './keyboard';
import { useReduceMotion, EASE } from './motion';
import { feedback } from './feedback';
import type { FeedbackKind } from '../../engines/feedback';

/**
 * Everything that floats above a screen. All of it goes through `Modal` so it
 * sits above the tab bar and takes the hardware back button on Android — a
 * sheet you cannot dismiss with Back is a sheet people force-quit the app to
 * escape.
 */

/* ------------------------------------------------------------------ scrim */

/**
 * The modal every sheet floats in: the screen stays where it is and DIMS, and
 * only the sheet rises.
 *
 * It used to be `animationType="slide"` on the `Modal` itself, which slides the
 * modal's whole window — the dim layer included. So pressing `+` dropped a dark
 * pane over the screen from below, and on edge-to-edge Android the window
 * behind it was drawn black for a frame before the scrim arrived: the page
 * flickered and the sheet appeared to open on black rather than on the screen
 * somebody was looking at. The `Modal` now does no animation at all; the scrim
 * fades and the sheet translates, each on its own value.
 *
 * Closing plays the same motion backwards before the `Modal` goes, which is why
 * `shown` lags `open` on the way out — a sheet that blinks off reads as the app
 * dropping a frame.
 */
function SheetModal({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const reduce = useReduceMotion();
  const progress = React.useRef(new Animated.Value(0)).current;
  const [shown, setShown] = React.useState(open);
  const [sheetHeight, setSheetHeight] = React.useState(480);

  /**
   * DRAGGED DOWN, IT GOES. The grabber has always been drawn on these sheets
   * and has never done anything: it is the universal sign for "pull me", and a
   * sign that does nothing teaches people the app ignores them. Only the top
   * strip listens (`grab`), never the body — the body is a ScrollView full of
   * forms, and a sheet that closed when somebody scrolled up through a reason
   * they were typing would lose the reason.
   *
   * Past a third of its own height, or flicked, it closes; anything less
   * springs back. Plain `PanResponder` rather than gesture-handler, which was
   * removed to keep the APK lean and is not needed for one vertical drag.
   */
  const drag = React.useRef(new Animated.Value(0)).current;
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  const heightRef = React.useRef(sheetHeight);
  heightRef.current = sheetHeight;
  const grab = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
        onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_e, g) => {
          if (g.dy > heightRef.current / 3 || g.vy > 0.9) {
            feedback('tap');
            closeRef.current();
            /* Let the close animation carry on from where the finger left it. */
            Animated.timing(drag, { toValue: 0, duration: 200, delay: 180, useNativeDriver: true }).start();
          } else {
            Animated.spring(drag, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
        },
      }),
    [drag],
  );

  /* Adjusted during render rather than in an effect, so the Modal is mounted on
     the same pass `open` turns true. */
  if (open && !shown) setShown(true);

  React.useEffect(() => {
    if (!shown) return;
    if (reduce) {
      progress.setValue(open ? 1 : 0);
      if (!open) setShown(false);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: open ? 240 : 180,
      easing: open ? Easing.bezier(0.2, 0, 0, 1) : Easing.bezier(0.4, 0, 1, 1),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished && !open) setShown(false);
    });
    return () => anim.stop();
  }, [open, shown, reduce, progress]);

  return (
    <Modal
      visible={shown}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: progress }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height)}
          style={{
            transform: [
              {
                translateY: Animated.add(
                  progress.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] }),
                  drag,
                ),
              },
            ],
          }}>
          {children}
          {/* The grab strip: the 160 × 32 points around the grabber and
              nowhere else, so a close button or a title in a sheet's top
              corner still takes its own taps. */}
          <View
            {...grab.panHandlers}
            accessibilityLabel="Drag down to close"
            style={{ position: 'absolute', top: 0, left: '50%', marginLeft: -80, width: 160, height: 32 }}
          />
        </Animated.View>
      </View>
    </Modal>
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
export type ToastTone = 'success' | 'info' | 'warn' | 'error';

/**
 * WHAT EACH TONE LOOKS LIKE, in one place.
 *
 * The toast used to be a dark purple slab with white text, the same slab for a
 * saved order and a refused one, and only a refusal could be closed. It is a
 * white card now, the same surface as every other card in the app, so it reads
 * as part of the screen rather than as a banner pasted over it — and the TONE
 * is carried by an edge, an icon and its tint, never by flooding the whole card
 * with colour. A red card shouts; a red edge on a white card tells.
 */
const TONE: Record<
  ToastTone,
  { accent: string; tint: string; icon: 'tick' | 'bell' | 'alert'; label: string; feel: FeedbackKind | null }
> = {
  success: { accent: C.success, tint: C.successBg, icon: 'tick', label: 'Done', feel: 'success' },
  info: { accent: C.primary, tint: C.primaryTint, icon: 'bell', label: 'Note', feel: null },
  warn: { accent: C.warn, tint: C.warnBg, icon: 'alert', label: 'Check this', feel: 'warning' },
  error: { accent: C.danger, tint: C.dangerBg, icon: 'alert', label: 'Not done', feel: 'error' },
};

/* Every notice leaves after three seconds, whatever its tone, and the ×
   closes it sooner. One number, so no tone lingers over the screen. */
const DWELL_MS = 3000;

export function Toast({
  message,
  onDone,
  lift = 0,
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
  const [showing, setShowing] = React.useState<{ message: string; tone: ToastTone } | null>(null);

  React.useEffect(() => {
    if (message) setShowing({ message, tone });
  }, [message, tone]);

  /* ONE way out, whether it is the timer or a thumb that ends it. Held apart
     from the effect below because a tap has to be able to run it too, and two
     copies of "animate out, then tell the store" is how one of them forgets to
     clear `showing` — which is exactly what the reduce-motion path did, leaving
     the card on screen for good. */
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

  /**
   * THE TOAST IS WHERE MOST OUTCOMES ARE ANNOUNCED, so it is where most of them
   * are FELT. Every save in the app that confirms itself does it through
   * `notify()`, and every refusal too — so one line here gives an order, a
   * payment, a leave request and forty other saves the same buzz, and a
   * refusal the same "no", without any of those screens learning that a
   * motor exists. `info` stays silent: a note is not an outcome.
   */
  React.useEffect(() => {
    if (!message) return;
    const feel = (TONE[tone] ?? TONE.info).feel;
    if (feel) feedback(feel);
  }, [message, tone]);

  /* Swiped sideways, it goes — the way every notification on the phone does. */
  const swipe = React.useRef(new Animated.Value(0)).current;
  const leaveRef = React.useRef<() => void>(() => {});
  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_e, g) => swipe.setValue(g.dx),
        onPanResponderRelease: (_e, g) => {
          if (Math.abs(g.dx) > 90 || Math.abs(g.vx) > 0.8) {
            Animated.timing(swipe, {
              toValue: g.dx > 0 ? 420 : -420,
              duration: 160,
              easing: EASE,
              useNativeDriver: true,
            }).start(() => {
              leaveRef.current();
              swipe.setValue(0);
            });
          } else {
            Animated.spring(swipe, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(swipe, { toValue: 0, useNativeDriver: true }).start();
        },
      }),
    [swipe],
  );
  leaveRef.current = () => {
    progress.setValue(0);
    setShowing(null);
    onDone();
  };

  React.useEffect(() => {
    if (!message) return;
    const dwell = DWELL_MS;

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
  /* An unknown tone draws as a plain note rather than taking the screen down
     — a toast is never worth a crash. */
  const look = TONE[showing.tone] ?? TONE.info;
  return (
    <Animated.View
      /* The card takes touches only on itself, never on the space around it,
         so it cannot swallow a tap meant for the screen underneath. */
      pointerEvents="box-none"
      accessibilityLiveRegion={look === TONE.error ? 'assertive' : 'polite'}
      style={[
        st.toast,
        {
          /* 28 clears the raised + button, which sits 20 above the bar. */
          bottom: TAB_BAR_HEIGHT + insets.bottom + 28 + lift,
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
            { translateX: swipe },
          ],
        },
      ]}
      {...pan.panHandlers}>
      <View style={[st.toastAccent, { backgroundColor: look.accent }]} />
      <View style={[st.toastIcon, { backgroundColor: look.tint }]}>
        <Icon name={look.icon} size={16} color={look.accent} strokeWidth={2.4} />
      </View>
      <Text
        accessibilityLabel={look.label + '. ' + showing.message}
        style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink, paddingVertical: 2 }, weight(500)]}>
        {showing.message}
      </Text>
      <Pressable
        onPress={leave}
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={10}
        style={st.toastClose}>
        <Icon name="close" size={16} color={C.muted} strokeWidth={2.2} />
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
    <SheetModal open={open} onClose={onClose}>
      <View style={[st.sheet, keyboardHeight > 0 && { marginBottom: keyboardHeight }]}>
        {/* The grabber says the sheet can be pulled down — and now it can. */}
        <View style={[st.grabber, { marginTop: 8, marginBottom: -4 }]} />
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
    </SheetModal>
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
  /* `glyph: string` AND IT WANTS TO BE `IconName`. `Icon` falls back to the
     three-dot "more" glyph for a name it does not carry, so a typo here draws
     the very symbol that opened this sheet and nothing anywhere reports it —
     which is exactly how "Request a tour" shipped asking for a `cal` that did
     not exist. Narrowing it stops the build in ONE place first,
     `shell/AppFrame.tsx:306`, whose own `sheetItems` prop is typed `string`;
     annotate that as `IconName` and this line can follow, and then so can
     `Icon`'s own `name`. See the note on it. */
  items: { glyph: string; label: string; sub: string; run: () => void }[];
  onClose: () => void;
}) {
  const keyboardHeight = useKeyboardHeight();
  return (
    <SheetModal open={open} onClose={onClose}>
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
    </SheetModal>
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
          {error ? <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Please write a reason.</Text> : null}
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

  /* A month change SLIDES the way it went — next month comes in from the
     right, the previous from the left — so it reads as paging through time
     rather than as the grid being redrawn with different numbers. */
  const reduce = useReduceMotion();
  const slide = React.useRef(new Animated.Value(0)).current;
  const page = (by: number) => {
    feedback('select');
    setOffset(offset + by);
    if (reduce) return;
    slide.setValue(by * 24);
    Animated.timing(slide, { toValue: 0, duration: 220, easing: EASE, useNativeDriver: true }).start();
  };
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
        <Pressable onPress={() => page(-1)} accessibilityLabel="Previous month" style={st.calNav}>
          <Text style={{ fontSize: 20, color: C.body }}>‹</Text>
        </Pressable>
        <Text style={[{ flex: 1, textAlign: 'center', fontSize: 16, color: C.ink }, weight(600)]}>
          {monthName(shown.getMonth()) + ' ' + shown.getFullYear()}
        </Text>
        <Pressable onPress={() => page(1)} accessibilityLabel="Next month" style={st.calNav}>
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

      <Animated.View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          opacity: slide.interpolate({ inputRange: [-24, 0, 24], outputRange: [0.2, 1, 0.2] }),
          transform: [{ translateX: slide }],
        }}>
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
              onPress={() => {
                if (off) return;
                if (!picked) feedback('select');
                onPick(key);
              }}
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
      </Animated.View>
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
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.hairline,
    paddingLeft: 18,
    paddingRight: 8,
    paddingVertical: 10,
    minHeight: 56,
    overflow: 'hidden',
    boxShadow: '0 10px 28px -10px rgba(22,22,22,0.28), 0 2px 6px rgba(22,22,22,0.06)',
  },
  /* The tone, said by an edge rather than by flooding the card. */
  toastAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  toastIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
