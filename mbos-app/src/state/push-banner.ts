/**
 * Whether the app is drawing its own banner for a push that arrives while it
 * is on screen — the one fact `native/push.ts` needs to decide whether the
 * system's heads-up should show as well.
 *
 * A counter rather than a boolean, so a banner host that remounts (a fast
 * refresh, a provider re-keyed) never leaves the flag false while another is
 * still mounted.
 */
let hosts = 0;

export function hasBannerHost(): boolean {
  return hosts > 0;
}

export function registerBannerHost(): () => void {
  hosts += 1;
  return () => {
    hosts = Math.max(0, hosts - 1);
  };
}
