import React from 'react';
import { Keyboard, Platform } from 'react-native';

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
