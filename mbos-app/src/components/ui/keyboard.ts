import React from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  ScrollView,
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

/**
 * How much of the screen the keyboard is covering, right now.
 *
 * Everything here is measured rather than assumed, for one reason: this app
 * runs edge-to-edge on Android, and an edge-to-edge window does NOT resize
 * when the keyboard opens. The old advice — set `adjustResize` and let the
 * system deal with it — silently stops working, and the field the person is
 * typing into ends up behind the keyboard with nothing in the code looking
 * wrong.
 *
 * The events fire on both platforms and carry the real height, so the layout
 * can lift by exactly that much. It also needs no native module, which matters
 * because this has to work in Expo Go.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = React.useState(0);

  React.useEffect(() => {
    /* iOS reports the keyboard before it animates in, so `Will` keeps the lift
       in step with the slide. Android only has `Did`. */
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}

/** Whether the keyboard is up. For hiding chrome that would sit behind it. */
export function useKeyboardOpen(): boolean {
  return useKeyboardHeight() > 0;
}

/** Breathing room between the bottom of the field and the top of the keys. */
const FIELD_GAP = 24;

/**
 * Scrolls whatever is being typed into back above the keyboard.
 *
 * Making room is half of it. The frame and the sheet both pad their scroll
 * area by the keyboard's height, but padding only means the field CAN be
 * scrolled to — on an edge-to-edge Android window nothing scrolls it there,
 * so the box somebody just tapped sits behind the keys until they drag the
 * screen up themselves, which reads as the keyboard covering the form.
 *
 * Measured in window coordinates on both ends, and only ever scrolled
 * FORWARD by the overlap: a field already in view is left exactly where it
 * is, rather than every tap yanking the page to line the box up with the
 * keyboard the way `scrollResponderScrollNativeHandleToKeyboard` does — that
 * one assumes the scroll view fills the screen, and here it sits under a
 * header.
 *
 * Returns the ScrollView's ref and its scroll handler; both are needed,
 * because a ScrollView cannot be asked where it currently is.
 */
export function useRevealFocusedField(keyboardHeight: number) {
  const ref = React.useRef<ScrollView>(null);
  const offset = React.useRef(0);

  const onScroll = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.y;
  }, []);

  React.useEffect(() => {
    if (keyboardHeight <= 0) return;
    /* A frame later, so the padding the caller adds for the keyboard has been
       laid out — scrolling before it exists is clamped to the old end of the
       content and stops short. */
    const frame = requestAnimationFrame(() => {
      const field = TextInput.State.currentlyFocusedInput();
      if (!field || !ref.current) return;
      const keyboardTop =
        Keyboard.metrics()?.screenY ?? Dimensions.get('window').height - keyboardHeight;
      field.measureInWindow((_x, y, _w, h) => {
        const overlap = y + h + FIELD_GAP - keyboardTop;
        if (overlap > 0) ref.current?.scrollTo({ y: offset.current + overlap, animated: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboardHeight]);

  return { ref, onScroll };
}
