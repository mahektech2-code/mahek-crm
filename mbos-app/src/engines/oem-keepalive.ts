/**
 * KEEPING THE TRACKER ALIVE ON THE HANDSETS THIS BOOK ACTUALLY RUNS ON.
 *
 * Android's documented contract says a foreground service with an ongoing
 * notification keeps running. Every OEM in this market breaks it. The
 * watchdog next door records what that looks like from inside the app: the OS
 * accepts `startLocationUpdatesAsync`, answers yes, and then delivers
 * nothing — a salesman checked in at 04:16 and by half past twelve his
 * handset had posted not one position, with `background_location_granted`
 * reading TRUE the whole time. Funtouch had killed the service behind it.
 *
 * There is no API that asks "am I allowed to keep running". What every field
 * app that works in India does instead — Uber, FieldSense, the courier
 * apps — is WALK THE USER THROUGH the two or three OEM switches, once, and
 * then keep checking whether fixes are actually arriving.
 *
 * Two kinds of switch, and they are not the same:
 *
 *   BATTERY OPTIMISATION is standard Android. There is a real intent for it,
 *   `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is declared in `app.json`, and the
 *   system dialog grants it in one tap. Every handset has it.
 *
 *   AUTOSTART is the OEM's own, has no intent anybody may rely on, and cannot
 *   be granted programmatically at all. The best available is to open the
 *   screen it lives on and say in words what to tap. Xiaomi calls it
 *   Autostart, Oppo and Realme Auto-launch, vivo hides it under high
 *   background power consumption, Samsung inverts it as "never sleeping apps".
 *
 * PURE, and an engine rather than three lines inside the screen, for the
 * reason `cadence.ts` and `trail-watchdog.ts` beside it both give: anything
 * that imports a native module cannot be exercised without a device, and a
 * rule nobody can test is a rule nobody can be sure of. This file decides
 * WHICH steps a handset needs and what they are called; `native/keepalive.ts`
 * is the half that fires an intent.
 */

/** What `expo-device`'s `manufacturer` looks like, lower-cased. */
export type Oem =
  | 'xiaomi'
  | 'oppo'
  | 'vivo'
  | 'samsung'
  | 'oneplus'
  | 'realme'
  | 'other';

export type KeepAliveStep = {
  /** Stable, so "has he done this one" survives a reworded label. */
  key: 'battery' | 'autostart';
  title: string;
  /** What to tap once the screen opens. Named because we cannot do it for him. */
  detail: string;
  /**
   * Whether the system can actually GRANT this, or only show the screen.
   *
   * The difference is the whole of what the screen must not lie about.
   * Battery optimisation comes back granted or not; autostart is a page we
   * open and a sentence we print, and the handset has no way to learn what he
   * did there. Marking both "done" the same way would be the app claiming
   * something it cannot know.
   */
  grantable: boolean;
};

/**
 * The manufacturer, folded to the ones whose settings differ.
 *
 * OnePlus and Realme both run ColorOS derivatives and both are kept separate
 * from Oppo anyway, because the MENU PATH a salesman is being read out loud
 * differs and a path that does not match what is on his screen is worse than
 * no path at all — he stops trusting the instructions and stops following any
 * of them.
 */
export function oemOf(manufacturer: string | null | undefined): Oem {
  const m = (manufacturer ?? '').trim().toLowerCase();
  if (!m) return 'other';
  if (m.includes('xiaomi') || m.includes('redmi') || m.includes('poco')) return 'xiaomi';
  if (m.includes('oneplus')) return 'oneplus';
  if (m.includes('realme')) return 'realme';
  if (m.includes('oppo')) return 'oppo';
  if (m.includes('vivo') || m.includes('iqoo')) return 'vivo';
  if (m.includes('samsung')) return 'samsung';
  return 'other';
}

/** Where autostart lives, in that OEM's own words. Empty where there is none. */
const AUTOSTART: Record<Oem, string> = {
  xiaomi: 'Settings → Apps → Manage apps → MahekOne → turn on Autostart, and set Battery saver to No restrictions.',
  oppo: 'Settings → Battery → App battery usage → MahekOne → Allow background activity, and turn on Auto-launch.',
  realme: 'Settings → Battery → App battery usage → MahekOne → Allow background activity, and turn on Auto-launch.',
  oneplus: 'Settings → Battery → Battery usage → MahekOne → set to Unrestricted, and turn off Sleep standby optimisation.',
  vivo: 'Settings → Battery → Background power consumption → MahekOne → Allow. Then Settings → Apps → Autostart → turn MahekOne on.',
  samsung: 'Settings → Battery → Background usage limits → add MahekOne to Never sleeping apps.',
  other: '',
};

/**
 * What this handset needs doing, in the order to do it.
 *
 * Battery first, always: it is the one that can be granted in a single tap
 * and the one that is the same on every phone, so it is the step most likely
 * to be finished. Asking somebody to walk a six-level OEM menu before that is
 * how a setup screen gets abandoned half way.
 *
 * A handset with no OEM quirk we know of gets the battery step alone. Printing
 * an autostart path we are guessing at would send somebody looking for a menu
 * that is not there, and the honest answer to "we do not know where it is on
 * your phone" is to not claim to.
 */
export function keepAliveSteps(oem: Oem): KeepAliveStep[] {
  const steps: KeepAliveStep[] = [
    {
      key: 'battery',
      title: 'Let MahekOne run in the background',
      detail:
        'Android stops apps it thinks are using battery. This one has to keep recording while your day is open. Tap Allow on the box that appears.',
      grantable: true,
    },
  ];
  const path = AUTOSTART[oem];
  if (path) {
    steps.push({
      key: 'autostart',
      title: 'Allow it to start on its own',
      detail: path,
      grantable: false,
    });
  }
  return steps;
}

/**
 * Whether to put the setup in front of somebody.
 *
 * ONLY ONCE, and only where it would help. The steps are shown when the phone
 * has not been set up, and again when the watchdog has caught the tracker
 * being silenced — which is the evidence that whatever was or was not tapped
 * is not holding. A prompt on every check-in is a prompt people learn to
 * dismiss without reading, and this one has to be read to work.
 */
export function shouldOfferSetup(args: {
  askedAt: number | null;
  trailStalled: boolean;
  now: number;
  /** How long before an unanswered prompt may be shown again. */
  remindAfterMs: number;
}): boolean {
  if (args.trailStalled) return true;
  if (args.askedAt === null) return true;
  return args.now - args.askedAt >= args.remindAfterMs;
}
