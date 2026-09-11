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
  /** When he checked in — what a dead trail is measured from. */
  checkInAt: Date | string | null;
  /**
   * THE NEWEST FIX THE TRAIL ITSELF HAS PRODUCED, and nothing else.
   *
   * Deliberately NOT the row's `seenAt`, which is the newest of three sources
   * — the trail, the check-in and each visit — and is exactly the fact that
   * hid this for as long as it was hidden. A salesman whose tracking is dead
   * still checks in, and that one fix gives him a pin, a place and a time on
   * the team list; read as evidence of a trail it says the opposite of the
   * truth. Null here means the trail has produced nothing at all today.
   */
  trailSeenAt: Date | string | null;
  /**
   * WHAT THE PHONE SAID ABOUT ITSELF WHEN THE DAY OPENED — see the three
   * columns on `mbos_attendance_days`.
   *
   * `setupReady` false is a day that opened on a phone that could not show it
   * would record; `setupAcknowledgedAt` is the man saying he had done the
   * autostart and battery steps, which no API can check and which is therefore
   * a CLAIM. Null is a handset too old to report any of it and is never read
   * as "nothing was wrong".
   */
  setupReady: boolean | null;
  setupAcknowledgedAt: Date | string | null;
  setupUnverified: string[] | null;
  /**
   * WHETHER THE BACKGROUND MACHINERY IS ACTUALLY RUNNING.
   *
   * `registered` is what the OS answered when asked; `lastRunAt` is the only
   * evidence it meant it. An OEM battery manager leaves the first true and
   * never delivers the second, which is precisely the failure that made "it
   * is switched on and nothing arrives" unanswerable. Null on both is a
   * handset too old to report it and is never read as a no.
   */
  backgroundSyncRegistered: boolean | null;
  backgroundSyncLastRunAt: Date | string | null;
  /** When the handset's own watchdog last caught the tracker accepted and silent. */
  trackerStalledAt: Date | string | null;
};

export type HandsetThresholds = {
  quietMinutes: number;
  noTrailMinutes: number;
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
 *
 * AND `always` IS NOT A PROMISE OF A TRAIL. It is the strongest thing this
 * column can say and it still only says what the OS granted — an OEM battery
 * manager is perfectly free to kill a service that started with every
 * permission it asked for, and on some handsets it does so within minutes.
 * Nothing in this function can see that; what sees it is `trailIsDead` below,
 * reading the positions themselves. The two are not alternatives: a phone
 * reading `always` here and producing nothing all day is the exact shape of
 * the incident this module was corrected for, and it is caught downstairs.
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
 * CHECKED IN, AND THE TRAIL HAS PRODUCED NOTHING.
 *
 * The fault that had no sentence anywhere. A salesman checked in at 04:16 and
 * by half past twelve had posted not one position — ever, since his phone was
 * bound — while his handset was demonstrably fine: it had synced ninety
 * minutes earlier, the check-in and its photograph had both arrived, and the
 * check-in's own GPS fix was good. The map drew him at that fix, the team list
 * said "Last seen 04:16", and the only note against him was that he had gone
 * quiet — a sentence that is true of the interval and wrong about the phone,
 * and which sends a manager hunting a signal problem that does not exist.
 *
 * EVERY PERMISSION HE HOLDS READS CORRECT, and that is the point rather than a
 * complication. `background_location_granted` is written at the end of the
 * handset's `start()` from an answer that has already refused to be true
 * unless the OS reported the background permission granted — so it maps onto
 * `always` above and it is not lying. The service started with everything it
 * asked for and an OEM battery manager killed it anyway, which is a thing no
 * column on `mbos_devices` can report and only the absence of positions can.
 * That makes this the ONLY line that catches a handset like his, which is why
 * it fires whatever the permissions say.
 *
 * It is measured from the CHECK-IN and not from the start of the day, because
 * the trail cannot produce anything before there is a day to produce it in,
 * and a threshold is what keeps a morning's first four minutes from reading as
 * a fault. And it asks `trailSeenAt`, never the row's `seenAt` — see that
 * field's own note: the check-in fix is precisely what made this invisible.
 *
 * One function, because the Live map's banner counts these and each row
 * explains its own, exactly as `trailHasGaps` is shared above it.
 */
export function trailIsDead(
  f: Pick<HandsetFacts, "dayOpen" | "checkInAt" | "trailSeenAt">,
  t: Pick<HandsetThresholds, "noTrailMinutes">,
  nowMs: number,
): boolean {
  if (!f.dayOpen) return false;
  if (ms(f.trailSeenAt) !== null) return false;
  const checkedIn = ms(f.checkInAt);
  if (checkedIn === null) return false;
  return nowMs - checkedIn > t.noTrailMinutes * 60_000;
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
   * THE PHONE KILLED THE TRACKER, and it is first because it outranks every
   * permission below it.
   *
   * Each of those sends somebody to a settings screen to grant something. This
   * one is the opposite case: everything IS granted, the OS accepted the task,
   * and the handset's own watchdog then caught it delivering nothing. Drawing
   * a permission note over the top of that sends a manager to ask for a switch
   * that is already on, and the salesman — who can see it is on — stops
   * believing the next thing the office tells him.
   */
  const stalled = ms(f.trackerStalledAt);
  if (stalled !== null && f.dayOpen) {
    notes.push({
      tone: "bad",
      text: `His phone stopped the tracker — ${ageWords(stalled, nowMs)} ago`,
      detail:
        "Every permission is granted and the OS accepted the task; the handset's battery manager killed it anyway, which no API reports. He fixes it once on Sync → Keep tracking on, and until he does the route records only while the app is open.",
    });
  }

  /*
   * IT CAN NEVER SYNC WITH THE APP SHUT, which is a different fault.
   *
   * `false` here is the OS refusing to register the periodic wake-up at all —
   * the handset is not being killed, it was never started. It had looked
   * exactly like a working phone from this screen, because nothing asked.
   */
  if (f.backgroundSyncRegistered === false) {
    notes.push({
      tone: "bad",
      text: "Background sync never started on this phone",
      detail:
        "The OS refused the periodic wake-up, so nothing reaches the office while the app is shut — his work goes up only when he opens it. Reinstalling the app is what re-asks; if it refuses again the handset is too restricted and he should be given another.",
    });
  } else if (f.backgroundSyncRegistered === true && f.dayOpen) {
    /* REGISTERED AND SILENT is the one worth a warning of its own. The floor
       is roughly fifteen minutes on both Android and iOS, so silence well past
       that is the OS having quietly stopped honouring it. */
    const ran = ms(f.backgroundSyncLastRunAt);
    if (ran !== null && nowMs - ran > 45 * 60_000) {
      notes.push({
        tone: "warn",
        text: `No background sync for ${ageWords(ran, nowMs)}`,
        detail:
          "The wake-up is registered and the phone has stopped honouring it — the usual cause is battery optimisation. His work is safe on the handset and goes up the moment he opens the app.",
      });
    }
  }

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
   * THE TRAIL ITSELF, and it outranks everything below it.
   *
   * It sits above the battery and above the silence because it is the only
   * line on the row that names what is actually broken — the two under it are
   * context and a duration, and on the day this was written the duration was
   * the ONLY thing said, which is how a manager spent a morning looking for a
   * signal fault on a phone that was syncing.
   *
   * It is not folded into the permission block above and does not replace any
   * of it: those sentences are about a SETTING and this one is about TODAY.
   * A handset can hold "Allow all the time" and still produce nothing — this
   * one did — and a phone reporting `while_using` with a trail full of holes
   * is a different row from one with no trail at all. Both lines can appear
   * and each is worth its own reading.
   *
   * WHAT IT ASKS FOR IS THE BATTERY MANAGER, not the permission. The commonest
   * reader of this line is a manager looking at a row whose permission is
   * already correct, and sending him to a settings screen that is right takes
   * the one person who could fix this and spends his call proving nothing.
   * Autostart and battery optimisation are where these handsets kill a service
   * that started properly; the permission is named last, and only because a
   * build too old to report `location_permission` leaves it unconfirmed.
   */
  const checkedIn = ms(f.checkInAt);
  if (checkedIn !== null && trailIsDead(f, t, nowMs)) {
    /*
     * AND IF HE WAS ALREADY MADE TO ANSWER FOR IT, the sentence is a different
     * one — the one pattern the start-of-day gate exists to make visible.
     *
     * The handset stops a day from opening on a phone that cannot show it will
     * record, and where the failing steps are ones no API can check — the
     * autostart and battery screens an OEM buries — it opens on the man saying
     * he has done them. That claim is worth exactly as much as the trail that
     * follows it, and here there is none: this is somebody who has been
     * through the setup screen, pressed the button, and is STILL not being
     * recorded. Telling a manager to send him to those settings a second time
     * spends the one call that could fix this on the thing that has already
     * failed, which is why the two sentences are not both shown and not the
     * same sentence.
     */
    const claimedAt = ms(f.setupAcknowledgedAt);
    if (claimedAt !== null) {
      const outstanding = f.setupUnverified?.length
        ? ` Still outstanding when he answered: ${f.setupUnverified.join(", ")}.`
        : "";
      notes.push({
        tone: "bad",
        text: `No position all day — and he said the phone was set up`,
        detail:
          "He was stopped at the start of the day, taken through the setup screen, and answered that he had allowed MahekOne to autostart and set its battery usage to unrestricted. No phone can verify that answer, and the trail since says it did not take. This one needs a person rather than another instruction: go through those two settings WITH him, and if they are already correct then this is a handset this product cannot track and the office should know which model it is." +
          outstanding,
      });
    } else {
      notes.push({
        tone: "bad",
        text: `No position all day — checked in ${ageWords(checkedIn, nowMs)} ago`,
        detail:
          "The check-in reached MahekOne and not one position has since, so this is the tracking service on his phone rather than a handset we cannot hear from — the silence line, if there is one below, is measuring an interval and not naming this. The usual cause is the phone killing the service after it started perfectly well: ask him to allow MahekOne to autostart and to set its battery usage to unrestricted, in the phone's own battery settings, then check out and back in. Only if this row also says something about Location is the permission worth changing.",
      });
    }
  }

  /*
   * OPENED ANYWAY, WITH NOTHING CLAIMED. A day that started on a phone that
   * could not show it would record, and nobody said anything about it — which
   * means the gate is at `warn` (or `off`) in the office's own settings.
   *
   * It is worth a line at nine in the morning rather than a discovery at six
   * in the evening: this is a prediction of a lost day, made while there is
   * still a day to save. It is `warn` and not `bad` because the trail may yet
   * appear — the reading is of what the phone could PROVE, and plenty of
   * handsets that cannot prove it record perfectly well.
   */
  if (f.dayOpen && f.setupReady === false && ms(f.setupAcknowledgedAt) === null) {
    notes.push({
      tone: "warn",
      text: "Day opened on a phone that could not show it would record",
      detail:
        "The start-of-day check found something wrong and the day was allowed to start regardless, which is what `warn` on the field setting means. Nobody has claimed to have fixed anything, so expect the trail to be thin or absent — the row above says whether it has appeared.",
    });
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
   *
   * IT STILL FIRES ON A PHONE WE HAVE HEARD FROM, and that was reconsidered
   * rather than left alone. The vivo above had synced ninety minutes earlier
   * and was told it had not been heard from for ninety minutes, which read as
   * an accusation and was merely a measurement — so the temptation was to
   * suppress it on a handset that has spoken recently. There is no such thing:
   * `quietMinutes` IS the definition of recently, a manager set it, and a
   * second definition written in here would be two answers to one question on
   * one screen. What was actually wrong was that this was the only line on the
   * row. It now sits under a line that names the fault, which is where a
   * duration belongs.
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
