import React from 'react';

/**
 * Whether the app can draw its OWN banner for a push that arrives while it is
 * on screen — the one question `native/push.ts` asks to decide whether the
 * system's heads-up should show instead.
 *
 * THREE THINGS MUST ALL HOLD, and each was a way a push could be shown by
 * nobody, or by the wrong thing:
 *
 * - A banner is MOUNTED (`registerBannerHost`). A counter rather than a
 *   boolean, so a host that remounts never leaves the flag false while
 *   another is still there.
 * - The app is NOT LOCKED (`setAppLocked`). The banner lives under the lock
 *   in the tree but Android draws by elevation, not by order, so it would sit
 *   ON the cover — a refusal's reason readable, and tappable, by whoever
 *   picked the phone up. While locked the system shows it, exactly as it
 *   would on the phone's own lock screen.
 * - NO MODAL IS OPEN (`useModalOpen`). A sheet or a camera is its own Android
 *   window above the app, so a banner drawn in the app's window sits under it,
 *   buzzes, and leaves unseen. While one is open the system shows it.
 *
 * Whatever is true at the moment a push lands decides who shows it, and both
 * sides read the same answer — so it is shown once, never twice and never by
 * nobody.
 */
let hosts = 0;
let locked = false;
let modals = 0;

export function bannerCanShow(): boolean {
  return hosts > 0 && !locked && modals === 0;
}

export function registerBannerHost(): () => void {
  hosts += 1;
  return () => {
    hosts = Math.max(0, hosts - 1);
  };
}

const lockListeners = new Set<() => void>();

export function setAppLocked(v: boolean): void {
  if (locked === v) return;
  locked = v;
  lockListeners.forEach((l) => l());
}

/** For the banner, which has to drop out of sight the moment the app locks. */
export function useAppLocked(): boolean {
  return React.useSyncExternalStore(
    (l) => {
      lockListeners.add(l);
      return () => {
        lockListeners.delete(l);
      };
    },
    () => locked,
    () => locked,
  );
}

/** Called by every `Modal` in the app for as long as it is open. */
export function useModalOpen(open: boolean): void {
  React.useEffect(() => {
    if (!open) return;
    modals += 1;
    return () => {
      modals = Math.max(0, modals - 1);
    };
  }, [open]);
}
