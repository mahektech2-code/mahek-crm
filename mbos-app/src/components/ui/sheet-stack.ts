import React from 'react';

/**
 * WHICH WINDOW IS ON TOP, so the toast is drawn in the one he can see.
 *
 * Every sheet is a `Modal`, and on Android a Modal is a window of its own over
 * the app. The toast lived in the app's window, under `AppFrame` — so a refusal
 * raised from inside a sheet ("That file is over 10 MB", "Pick who gets the
 * bill first") buzzed and was drawn UNDER the sheet, where nobody could read
 * it. From the salesman's side the button simply did nothing.
 *
 * So each open sheet takes a ticket, and the toast is drawn by the newest one
 * — or by the screen when there are none. One reader of one store, drawn in
 * exactly one place at a time.
 */
let stack: number[] = [];
let next = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Holds a place on the stack for as long as `open` is true; returns its ticket. */
export function useSheetTicket(open: boolean): number | null {
  const [ticket, setTicket] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const t = next++;
    stack = [...stack, t];
    setTicket(t);
    emit();
    return () => {
      stack = stack.filter((x) => x !== t);
      setTicket(null);
      emit();
    };
  }, [open]);
  return ticket;
}

/** The ticket of the sheet on top, or null when no sheet is open. */
export function useTopSheet(): number | null {
  return React.useSyncExternalStore(
    subscribe,
    () => (stack.length ? stack[stack.length - 1] : null),
    () => null,
  );
}
