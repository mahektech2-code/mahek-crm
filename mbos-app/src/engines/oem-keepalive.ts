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

/* From the readiness engine beside it rather than from `native/phone-setup`,
   which declares the same union: that file imports the native module at module
   scope, and an engine that names it — even as a type — is one keystroke away
   from importing a value and becoming untestable. The same borrowing
   `tracker-notice.ts` makes, for the same reason. */
import type { BatteryExemption } from './phone-readiness';

/** What `expo-device`'s `manufacturer` looks like, lower-cased. */
export type Oem =
  | 'xiaomi'
  | 'oppo'
  | 'vivo'
  | 'samsung'
  | 'oneplus'
  | 'realme'
  /* Honor was Huawei's own sub-brand and both run EMUI's App launch screen.
     It is here because `phone-readiness.ts` carried a Huawei path and this
     file did not, so the same handset was given a menu by one screen and told
     "we do not know where it is on your phone" by the other. */
  | 'huawei'
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
  if (m.includes('huawei') || m.includes('honor')) return 'huawei';
  return 'other';
}

/**
 * THE NAME TO LOOK FOR IN THE PHONE'S OWN SETTINGS, and it was wrong in two
 * different ways at once.
 *
 * Every path below ends by telling somebody to find this app in a list. This
 * file called it "MahekOne" and `phone-readiness.ts` called it "MBOS", and the
 * label Android actually draws in that list is neither: it is `expo.name` from
 * `app.json`, which is **Mahek MBOS**. So a salesman hunting an autostart list
 * was looking for a name that is not on his screen — which is the exact failure
 * the header of this file warns about for menu paths, arriving through the app's
 * own name instead. He does not conclude he is looking at the wrong row; he
 * concludes the instructions are wrong and stops following them.
 *
 * It is a constant and interpolated rather than typed into eight strings,
 * because the day the launcher label changes is the day eight paths quietly
 * start naming something that no longer exists.
 */
export const APP_LABEL = 'Mahek MBOS';

/**
 * WHERE THE SWITCH LIVES, IN THAT PHONE'S OWN WORDS — one table, for both
 * screens.
 *
 * There were TWO. This file fed "Keep tracking on" and `phone-readiness.ts`
 * fed the start-of-day gate, and the same vivo handset was told to go to
 * `Settings → Battery → Background power consumption` by one and
 * `Settings → Apps → Special app access → Autostart` by the other, under two
 * different names for the app. That is worse than either answer alone: a man
 * given two paths for one switch has been told by the app itself that it does
 * not know, and the header above says exactly what that costs — he stops
 * believing the rest of the screen.
 *
 * `label` is the setting as the phone spells it, and it is what the gate draws
 * as a row title, because a row headed "Autostart" on a phone whose menu says
 * "Background power consumption" is the same failure one level up. `path` is
 * where it lives; `also` is the second setting on the same phone that undoes
 * the first, which on several of these is the one that actually matters.
 *
 * `null` is an honest "we do not know where it is on your phone" — never a
 * guess. A confident wrong path is worse than an admitted vague one.
 */
export type OemWords = { label: string; path: string; also: string | null };

const OEM_WORDS: Record<Oem, OemWords | null> = {
  /* vivo and iQOO are one company and one skin, Funtouch. This is the handset
     the whole gate was built for, and it is the one where both of the old
     tables were half right: OriginOS moved Autostart under Special app access
     and left the background-power screen where it was, so both are named and
     the second is the one that undoes the first. */
  vivo: {
    label: 'Autostart',
    path: `Settings → Apps → Special app access → Autostart → switch ${APP_LABEL} on.`,
    also:
      `Then Settings → Battery → Background power consumption management → ${APP_LABEL} → ` +
      'Allow high background power consumption.',
  },
  xiaomi: {
    label: 'Autostart',
    path: `Settings → Apps → Manage apps → ${APP_LABEL} → Autostart → switch it on.`,
    also: 'Then on the same page: Battery saver → No restrictions.',
  },
  /* Realme runs ColorOS too, and both skins call it the same thing. They are
     kept apart from OnePlus because that MENU PATH differs. */
  oppo: {
    label: 'Auto-launch',
    path: `Settings → Apps → App management → ${APP_LABEL} → Auto-launch → switch it on.`,
    also: `Then Settings → Battery → App battery management → ${APP_LABEL} → Allow background running.`,
  },
  realme: {
    label: 'Auto-launch',
    path: `Settings → Apps → App management → ${APP_LABEL} → Auto-launch → switch it on.`,
    also: `Then Settings → Battery → App battery management → ${APP_LABEL} → Allow background running.`,
  },
  oneplus: {
    label: 'Battery optimisation',
    path: `Settings → Apps → ${APP_LABEL} → Battery usage → Unrestricted.`,
    also: 'Then Settings → Battery → More → Advanced optimisation → switch Deep optimisation off.',
  },
  huawei: {
    label: 'App launch',
    path: `Settings → Battery → App launch → ${APP_LABEL} → Manage manually.`,
    also: 'Switch on all three: Auto-launch, Secondary launch and Run in background.',
  },
  /* Samsung has no autostart list as such; what it has is the list of apps it
     never puts to sleep. Different wording, same job. */
  samsung: {
    label: 'Never sleeping apps',
    path: `Settings → Battery → Background usage limits → Never sleeping apps → add ${APP_LABEL}.`,
    also: `Also check ${APP_LABEL} is not in the Sleeping apps or Deep sleeping apps list on the same page.`,
  },
  other: null,
};

/**
 * That phone's words, or the honest generic ones.
 *
 * READ BY BOTH SCREENS — `app/tracking-setup.tsx` through `keepAliveSteps`
 * below, and the start-of-day gate through `engines/phone-readiness.ts`, which
 * imports this rather than keeping the second copy it used to.
 */
export function oemWords(oem: Oem): OemWords {
  return (
    OEM_WORDS[oem] ?? {
      label: `Let ${APP_LABEL} run in the background`,
      path:
        'Open your phone Settings and look for Battery, then for anything about background apps, ' +
        `app launch or autostart. Set ${APP_LABEL} so the phone never stops it.`,
      also: null,
    }
  );
}

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
  const words = oemWords(oem);
  return [
    {
      key: 'battery',
      title: `Let ${APP_LABEL} run in the background`,
      detail:
        'Android stops apps it thinks are using battery. This one has to keep recording while your ' +
        'day is open. Tap Allow on the box that appears.',
      grantable: true,
    },
    {
      /* THE STEP IS ALWAYS OFFERED NOW, and the words are what change.
         
         It used to be dropped entirely on a handset whose make nobody had
         mapped — the honest half of that was refusing to print a guessed menu
         path, and the dishonest half was that the screen then showed one step
         and implied there was nothing else to do. `oemWords` answers with a
         real path or with generic wording that admits it is generic, so the
         step can stand either way and the salesman is never told a setting he
         has to find does not exist. */
      key: 'autostart',
      title: words.label,
      detail: words.path + (words.also ? ' ' + words.also : ''),
      grantable: false,
    },
  ];
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

/* ------------------------------------------------- and then what */

/**
 * WHAT TO DO ONCE THE SWITCHES ARE SET, which nothing in this app answered.
 *
 * The steps above open two settings screens and then the screen stopped. Every
 * salesman who worked through them asked the office the same question and the
 * office had nowhere to look it up: do I restart the app, or restart the
 * phone? Neither screen said, so the answers went round the team by word of
 * mouth — and a team that is guessing at a recovery step is a team that does
 * the wrong one, concludes it made no difference, and stops doing any of it.
 *
 * THE ANSWER IS NEITHER, USUALLY, and that is worth saying out loud rather
 * than leaving to be inferred from silence. Battery exemption is granted by a
 * system dialog and is in force the moment it is granted. Autostart governs
 * what the phone is willing to START, so it is read the next time recording
 * starts — which is the next check-in, and on a day already open it is the
 * retry `trail-retry.ts` bounds. A PHONE restart is never the fix and is never
 * offered: it is the folk remedy people reach for, it costs a man ten minutes
 * of his morning, and recommending it would be this screen inventing a step it
 * cannot justify.
 *
 * `RESTART_ANSWER` below is where the phone half is said, once, because both
 * screens that walk somebody to these settings have to say the same thing about
 * it. Nothing in the verdicts repeats it: a sentence written twice is a sentence
 * that comes to read two ways.
 *
 * THE ONE REAL RESTART IS THE APP'S, and only in one state: a day that is open
 * and recording at the foreground floor. There the phone has already refused
 * once in this process, the settings have since changed under it, and the
 * fastest honest way to have the new answer read is a fresh start. It is
 * offered THERE and nowhere else — a restart button on a handset that is
 * already recording properly is a button that can only lose somebody his place
 * in a half-typed order.
 *
 * PURE, like everything else in this file and for the same reason: the facts
 * it reads come from a native module and a file that imports expo-location, so
 * a rule written beside either could not be exercised without a handset.
 */

/**
 * THE ANSWER TO THE QUESTION THE TEAM ASKED, in one sentence and in one place.
 *
 * "Do I restart the app or restart the phone?" was asked of the office by
 * almost everybody who worked through the steps above, because two screens walk
 * a salesman to these settings — this one and the start-of-day gate in
 * `app/phone-setup.tsx` — and neither of them said. Both print this, from here,
 * so they cannot come to say different things: a team that has been given two
 * answers behaves exactly like a team that has been given none.
 *
 * It names the phone explicitly rather than staying silent about it. Silence is
 * what produced the folk remedy, and a man who has already rebooted his phone
 * twice this week needs to be told it was never the step.
 */
export const RESTART_ANSWER =
  'You do not need to restart your phone. The battery setting works the moment you allow it, and ' +
  'the autostart one is read the next time your day starts.';


/**
 * What is actually capturing the route, as `sync/trail.ts` knows it.
 *
 * `service` is our own foreground service, `background` is expo-location's
 * task, `floor` is the `setInterval` that only advances while the app is on
 * screen, and `null` is nothing running — which on this screen is very nearly
 * always a day that is not open rather than a fault.
 */
export type CaptureMode = 'service' | 'background' | 'floor' | null;

export type TrackingVerdict = {
  /** `good` is recording properly. `act` is something to do. `idle` is no day open. */
  tone: 'good' | 'act' | 'idle';
  title: string;
  detail: string;
  /**
   * The one thing to press, or null where there is nothing to press.
   *
   * `restart_app` is the app and never the phone. `recheck` re-reads the phone,
   * which is the honest action where the settings are done and no day is open
   * to prove it on.
   */
  action: 'restart_app' | 'recheck' | null;
};

export function trackingVerdict(i: {
  capture: CaptureMode;
  exemption: BatteryExemption;
  /** Can the app actually restart itself? False in development and where updates are off. */
  canRestart: boolean;
}): TrackingVerdict {
  /*
   * RECORDING PROPERLY BEATS EVERY PIECE OF ADVICE BELOW IT, including a
   * battery manager that is still switched on. Our own service holds capture up
   * through a reap, so a handset on it is working whatever the exemption says —
   * and telling a working handset to go and change more settings is how a
   * screen loses the authority it needs for the one time it matters.
   */
  if (i.capture === 'service' || i.capture === 'background') {
    return {
      tone: 'good',
      title: 'Your route is being recorded',
      detail:
        'It keeps going with the phone in your pocket, and it stops the moment you check out. ' +
        'Nothing else to do.',
      action: null,
    };
  }

  /*
   * THE FLOOR IS THE STATE THE WHOLE FEATURE EXISTS FOR, and the one where a
   * restart is a real remedy rather than folklore. The phone refused once
   * already in this process; the settings have changed since; a fresh start is
   * what gets the new answer read.
   */
  if (i.capture === 'floor') {
    return {
      tone: 'act',
      title: 'Only recording while the app is open',
      detail:
        (i.exemption === 'optimised'
          ? 'Your phone is still stopping MahekOne in the background — do the battery step above first. '
          : 'Your phone stopped MahekOne in the background earlier today. ') +
        (i.canRestart
          ? 'Restart MahekOne and it will try again. Nothing saved on this phone is lost by that.'
          : 'Close MahekOne completely and open it again, and it will try again. Nothing saved on ' +
            'this phone is lost by that.'),
      action: i.canRestart ? 'restart_app' : null,
    };
  }

  /*
   * NO DAY OPEN. Not a fault and never drawn as one — this is what the screen
   * says on every handset read outside working hours, which is most readings of
   * it. What it must not do is claim the settings are right: `exempt` is the one
   * thing here that IS readable, so it is stated, and autostart is left
   * unasserted exactly as it is everywhere else in this app.
   */
  return {
    tone: 'idle',
    title: 'Nothing to record yet',
    detail:
      (i.exemption === 'optimised'
        ? 'Battery saving is still switched on for MahekOne — do the step above, or your route will ' +
          'have holes in it. '
        : '') +
      'Recording starts when you start your day and stops when you check out.',
    action: 'recheck',
  };
}
