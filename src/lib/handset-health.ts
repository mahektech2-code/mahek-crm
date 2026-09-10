/**
 * WHY A SALESMAN IS NOT ON THE MAP — as words, in ONE place.
 *
 * "No fix today" was one sentence covering four completely different
 * situations: the background permission set to "while using the app",
 * location switched off on the phone itself, no signal all morning, and a
 * flat battery. A manager reading that sentence has no way to tell which, so
 * he rings the salesman and asks him to describe his own settings screen —
 * which is the support call this whole module exists to prevent.
 *
 * PURE AND CLIENT-SAFE, like `customer-health` and `seat-labels` beside it.
 * The Live map's team list is a client component and the thresholds arrive as
 * props, because a second copy of these rules typed into a screen is how the
 * panel and any future report come to disagree about one handset — and the
 * half that drifts is always the half somebody is reading.
 *
 * WHAT IT WILL NOT SAY is that somebody's internet is off. A phone with no
 * connection cannot report having no connection, so no reading could ever
 * carry that fact and any line claiming it would be an inference dressed as a
 * report. Silence carries it instead, and silence is `lastHeardAt`.
 */

/** How loudly a note is drawn. Nothing here is ever a refusal. */
export type NoteTone = "bad" | "warn" | "info";

export type HandsetNote = {
  tone: NoteTone;
  /** The line itself. Short enough for a 260px panel row. */
  text: string;
  /** The longer version, for a `title` — what to actually do about it. */
  detail?: string;
};

export type HandsetFacts = {
  /** Null where this build does not report it — NOT a refusal. */
  locationPermission: string | null;
  /** The older boolean, still all a handset in the field sends. */
  backgroundTrackingGranted: boolean | null;
  locationServicesEnabled: boolean | null;
  connectionType: string | null;
  batteryPercent: number | null;
  batteryCharging: boolean | null;
  deviceStateAt: Date | string | null;
  lastHeardAt: Date | string | null;
  /** A day that is open changes what silence MEANS — see below. */
  dayOpen: boolean;
};

export type HandsetThresholds = {
  quietMinutes: number;
  lowBatteryPercent: number;
};

const ms = (at: Date | string | null): number | null => {
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : null;
};

/** "47 min" / "3 hr 10 min" / "2 days" — an age somebody reads at a glance. */
export function ageWords(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * WHAT THE LOCATION SETTING IS, reading the new answer and falling back to
 * the old one.
 *
 * The four-way column is what a current handset sends; the boolean is what
 * every handset already in somebody's pocket sends, and both have to be read
 * for as long as those are out there. `true` on the old boolean can only have
 * been written by a handset that actually started background tracking, so it
 * maps cleanly onto `always`. `false` does NOT map onto anything, because it
 * is exactly the ambiguity the new column was added to end — it becomes
 * `restricted`, which says the trail has gaps without inventing a reason.
 */
type LocationState = "always" | "while_using" | "denied" | "undetermined" | "restricted" | "unknown";

function locationState(
  f: Pick<HandsetFacts, "locationPermission" | "backgroundTrackingGranted">,
): LocationState {
  if (f.locationPermission === "always") return "always";
  if (f.locationPermission === "while_using") return "while_using";
  if (f.locationPermission === "denied") return "denied";
  if (f.locationPermission === "undetermined") return "undetermined";
  if (f.backgroundTrackingGranted === true) return "always";
  if (f.backgroundTrackingGranted === false) return "restricted";
  return "unknown";
}

/**
 * Whether this handset's trail will have gaps no map can close.
 *
 * The Live map's banner counts these and each row explains its own, so the
 * two read the same function — a banner saying "two salesmen" above three
 * flagged rows is the kind of disagreement nobody reports and everybody
 * stops trusting.
 *
 * `undetermined` is deliberately NOT counted. Nobody has been asked yet,
 * which is a phone that has not started its first day rather than a setting
 * somebody has to go and change — and the row says so in its own words.
 */
export function trailHasGaps(
  f: Pick<HandsetFacts, "locationPermission" | "backgroundTrackingGranted" | "locationServicesEnabled">,
): boolean {
  if (f.locationServicesEnabled === false) return true;
  const state = locationState(f);
  return state === "while_using" || state === "denied" || state === "restricted";
}

/**
 * Everything worth saying about one handset, worst first.
 *
 * NOTHING IS SAID ABOUT A HEALTHY PHONE. A row that lists four green facts is
 * a specification sheet, and the one line that matters gets read as furniture
 * — which is the mistake the microphone made when it was drawn the same
 * weight as the resize grip. Silence here means "nothing to do about this
 * one", which is what a manager scanning eight rows needs.
 */
export function handsetNotes(
  f: HandsetFacts,
  t: HandsetThresholds,
  nowMs: number,
): HandsetNote[] {
  const notes: HandsetNote[] = [];

  /*
   * LOCATION OFF ON THE PHONE OUTRANKS ANY PERMISSION, and is checked first
   * for that reason: when the device's own location is off, what MahekOne was
   * granted is irrelevant and saying both would send somebody to the wrong
   * settings screen.
   */
  if (f.locationServicesEnabled === false) {
    notes.push({
      tone: "bad",
      text: "Location switched off on the phone",
      detail:
        "This is the phone's own location toggle, not MahekOne's permission — no app on the handset can get a fix. He turns it back on in the phone's quick settings.",
    });
  } else {
    const state = locationState(f);
    if (state === "denied") {
      notes.push({
        tone: "bad",
        text: "Location refused for MahekOne",
        detail:
          "There will be no trail at all, and visits will save with no coordinates. He grants it in his phone's Settings, under MahekOne's Location permission.",
      });
    } else if (state === "while_using") {
      notes.push({
        tone: "warn",
        text: "Location only while the app is open",
        detail:
          "The trail dies every time his phone locks, so the gaps are real rather than a fault in the map. He sets MahekOne's Location permission to 'Allow all the time' in his phone's Settings.",
      });
    } else if (state === "restricted") {
      /* The old boolean's `false`, which cannot say which of the two it is. */
      notes.push({
        tone: "warn",
        text: "Background location off — trail has real gaps",
        detail:
          "His trail stops whenever the phone locks. This handset reports only that background tracking did not start, not which setting caused it — ask him to set MahekOne's Location permission to 'Allow all the time'.",
      });
    } else if (state === "undetermined") {
      notes.push({
        tone: "info",
        text: "Location not asked for yet",
        detail:
          "The permission prompt appears when he first checks in, so this usually clears itself on his first working day.",
      });
    }
  }

  /*
   * BATTERY IS SHOWN WHEN IT IS ACTIONABLE, which is low or working, and it
   * ALWAYS carries the time it was read.
   *
   * "8%" on its own reads as now, and would have somebody ringing a salesman
   * whose phone charged three hours ago. Charging is part of the reading for
   * the same reason: 18% climbing needs no call at all.
   */
  const stateAt = ms(f.deviceStateAt);
  if (f.batteryPercent !== null && stateAt !== null) {
    const low = f.batteryPercent <= t.lowBatteryPercent;
    if (low || f.dayOpen) {
      const age = ageWords(stateAt, nowMs);
      const charge = f.batteryCharging ? ", charging" : "";
      notes.push({
        tone: low && !f.batteryCharging ? "warn" : "info",
        text: `Battery ${f.batteryPercent}%${charge} — read ${age} ago`,
        detail:
          "Whatever the handset last reported, not a live reading — it speaks when it syncs. A flat phone is the commonest reason a trail simply stops mid-beat.",
      });
    }
  }

  /*
   * SILENCE, and only where silence means something.
   *
   * On an OPEN day this is the real answer to "why has he stopped moving":
   * out of signal, out of battery, or the app closed. On a day nobody has
   * opened it means nothing at all — a phone in a drawer overnight is not a
   * fault, and flagging it would put a warning on every row every morning,
   * which is how a screen teaches people to ignore its warnings.
   */
  const heard = ms(f.lastHeardAt);
  if (f.dayOpen) {
    const quietMs = t.quietMinutes * 60_000;
    if (heard === null) {
      notes.push({
        tone: "warn",
        text: "Handset has never synced",
        detail: "Signed in, but nothing has reached MahekOne from this phone yet.",
      });
    } else if (nowMs - heard > quietMs) {
      const words = ageWords(heard, nowMs);
      const on = f.connectionType === "cellular" ? " — last on mobile data" : "";
      notes.push({
        tone: "warn",
        text: `Not heard from for ${words}${on}`,
        detail:
          "Nothing has reached MahekOne from this handset since then. A phone with no signal cannot tell us it has no signal, so this is the only evidence there is — no signal, no battery and a closed app all look exactly like this.",
      });
    }
  }

  return notes;
}
