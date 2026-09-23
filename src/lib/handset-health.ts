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
  /**
   * UNSENT FIXES STILL ON THE PHONE, or null where the build cannot say.
   *
   * Never read as zero when absent: a phone holding nothing and a phone that
   * cannot tell us are different facts, and drawing the second as "clear" is
   * the reassuring answer on the row that has earned it least.
   */
  queuedPositions: number | null;
  queuedPositionsAt: Date | string | null;
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
  /**
   * MBOS'S OWN RECORDER, and it is OPTIONAL on this type rather than nullable.
   *
   * Every other field here is `| null`, because every handset reports on every
   * one of them or reports null. These four arrived with a new APK, and a
   * sideloaded app has no staged rollout: most of the field is running a build
   * that has never heard of them, and so is most of the code that constructs
   * this object. Optional says exactly that — nothing was passed, so nothing
   * is asserted — where `| null` would have made every existing caller declare
   * an answer it does not have.
   *
   * `running` false with `undefined` are therefore NOT the same, and the note
   * below reads only the first.
   */
  locationServiceRunning?: boolean | null;
  locationServiceLastFixAt?: Date | string | null;
  /**
   * WHEN A BATCH WAS LAST ACCEPTED, and it is the only reading on this row
   * taken at OUR end.
   *
   * The recorder can say whether it BELIEVES it is sending — a cadence is set,
   * it holds a credential, the server has not refused that credential, the day
   * is open and the service is up. Every one of those is true of an uploader
   * that is wedged, and the app reads the same belief and leaves the queue to
   * it, so the buffer climbs towards its cap with nothing saying why. This is
   * the one fact that tells the two apart.
   */
  locationServiceLastUploadAt?: Date | string | null;
  locationServiceStartsToday?: number | null;
  locationServiceRefusedAt?: Date | string | null;
  locationServiceRefusal?: string | null;
  /**
   * WHICH BUILD IS IN HIS POCKET, or null where no handset has ever bound.
   *
   * It is a fact about the phone exactly like the battery is, and it belongs
   * here rather than on a screen because what it MEANS is a comparison — see
   * `buildIsBehind` — and a comparison typed into a panel is the second
   * vocabulary this file exists to prevent.
   */
  appVersion: string | null;
};

export type HandsetThresholds = {
  quietMinutes: number;
  noTrailMinutes: number;
  lowBatteryPercent: number;
  /** Unsent fixes worth saying out loud. See the note where it is read. */
  queuedPositionsWorthSaying: number;
  /**
   * How often the recorder is configured to POST — `serviceUploadEverySeconds`
   * as the office set it. ZERO is the escape hatch: the recorder does not send
   * at all and the app does, so there is no channel of its own to be silent on
   * and the note below never fires.
   *
   * It is not a threshold in its own right. It is here because a silence is
   * only meaningful against the interval it is a silence in — see
   * `uploaderSilenceMs`.
   */
  serviceUploadEverySeconds: number;
  /**
   * THE BUILD THE OFFICE HAS PUBLISHED, and it is a THRESHOLD rather than a
   * fact about any handset — which is the whole reason it sits here.
   *
   * Empty or null means nobody has stated one, and then nothing is said about
   * anybody's build: null is not an answer, and a screen that called every
   * phone current because the office had not filled a box in would be the
   * reassuring reading on the question that has earned it least.
   *
   * WHY IT IS STATED AND NOT DERIVED. The two honest-looking alternatives are
   * both worse. The server cannot read an APK, so it has no way to know what
   * was built; and taking the HIGHEST version any handset reports derives the
   * answer from the very population being judged — on a fleet where nobody has
   * updated, the newest straggler becomes "current" and every phone reads as
   * up to date, which is exactly the day this needed to speak. A release is a
   * decision somebody makes (see DEPLOY.md, "Releasing the handset app"), so
   * the number somebody decided is what this is compared against.
   */
  currentAppVersion: string | null;
};

/**
 * HOW LONG THE RECORDER'S OWN CHANNEL MAY BE SILENT — derived, never a third
 * number somebody typed.
 *
 * `quietMinutes` is the office's own answer to "how long may a working handset
 * go silent on a channel before this panel says so", and this asks exactly
 * that question of one channel rather than of the phone as a whole. A second
 * setting beside it would be a second answer to one question, invisible on the
 * screen that sets the first — which is the thing this codebase spends a
 * paragraph refusing everywhere else.
 *
 * The send cadence is a FLOOR under it and not a multiplier. At the defaults
 * it never binds — thirty minutes is three hundred six-second intervals — and
 * it exists for the corner where an office has set quiet to its five-minute
 * minimum and the send interval to its two-minute maximum, where a note could
 * otherwise fire on two ordinary posts going astray.
 */
export function uploaderSilenceMs(
  t: Pick<HandsetThresholds, "quietMinutes" | "serviceUploadEverySeconds">,
): number {
  return Math.max(t.quietMinutes * 60_000, t.serviceUploadEverySeconds * 1_000);
}

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
 * THE TRAIL RAN AND THEN STOPPED, which is the half `trailIsDead` cannot see.
 *
 * That function answers false the moment `trailSeenAt` is non-null, and it
 * says so in its own signature — it was written for a handset that produced
 * NOTHING all day. A trail that ran all morning and stopped at four in the
 * afternoon is not that handset: it has a `trailSeenAt`, it has a pin, it has
 * a place, and the team list prints "Last seen 16:12" beside a green dot. So
 * the commonest shape of a lost route had no sentence anywhere on this panel,
 * and the one line that did fire was the silence note underneath — which
 * measures an interval and names nothing, and which does not fire at all on
 * the case this exists for.
 *
 * THAT CASE IS A PHONE WE ARE HEARING FROM PERFECTLY. A handset flushing a
 * backlog posts batches every few minutes, and each one moves
 * `mbos_devices.last_seen_at` — so the office reads a handset in constant
 * contact while every position in those batches is hours old, because the
 * uploader stopped at four and the queue is only now catching up. Both
 * readings are true and they are about different things: one is when the
 * phone last spoke, the other is when it last knew where it was. A manager
 * with no line telling him which is which concludes the map is broken, and
 * that is what was reported.
 *
 * IT IS THE SAME THRESHOLD AS A DEAD TRAIL, deliberately. "How long may a
 * working handset produce no position before this panel says so" is one
 * question, and `noTrailMinutes` is the office's one answer to it; whether
 * the count before the silence was zero or four hundred does not change how
 * long the silence may run. A second setting would be a second answer to one
 * question, invisible on the screen that sets the first.
 *
 * The two are mutually exclusive by the null check, so one fact still gets
 * one sentence and the banners cannot count one handset twice.
 */
export function trailHasStopped(
  f: Pick<HandsetFacts, "dayOpen" | "trailSeenAt">,
  t: Pick<HandsetThresholds, "noTrailMinutes">,
  nowMs: number,
): boolean {
  if (!f.dayOpen) return false;
  const last = ms(f.trailSeenAt);
  /* Nothing at all is `trailIsDead`'s to say, and saying it twice would put
     two sentences on one row about one absence. */
  if (last === null) return false;
  return nowMs - last > t.noTrailMinutes * 60_000;
}

/**
 * THE HANDSET'S OWN WATCHDOG SAYS ITS TRACKER IS STOPPED.
 *
 * Its own function for the same reason `trailIsDead` and `trailHasGaps` have
 * theirs: the Live map's banner counts these and each row explains its own,
 * and a banner saying "two salesmen" over three flagged rows is the kind of
 * disagreement nobody reports and everybody stops trusting.
 *
 * IT IS A STANDING FACT AND NOT A HISTORY. The column is CLEARED the moment
 * the tracker delivers again — see `lib/mbos/device-state.ts` — so a value
 * present is a phone the watchdog believes is stalled AS OF ITS LAST CONTACT,
 * not a stall it had once. The age printed beside it is therefore how long the
 * phone has been in that state, which is the number a manager acts on.
 *
 * An open day is still required. Tracking runs only between a punch-in and a
 * punch-out, so a stall carried overnight on a phone in a drawer is a
 * yesterday that has not been cleared rather than a route being lost now, and
 * flagging every handset every morning is how a screen teaches people to
 * ignore it.
 */
export function trackerStalled(
  f: Pick<HandsetFacts, "dayOpen" | "trackerStalledAt">,
): boolean {
  return f.dayOpen && ms(f.trackerStalledAt) !== null;
}

/**
 * WHETHER THE PHONE IS RUNNING AN OLDER BUILD THAN THE ONE THE OFFICE
 * PUBLISHED — and null wherever that cannot be answered.
 *
 * Three separate ways this has no answer, and every one of them has to be null
 * rather than false: no handset has ever bound, the handset is too old to
 * report its version, and the office has not said what the current build is.
 * `false` would mean "this phone is up to date", which is a claim, and making
 * a claim out of a missing input is the one failure this whole file is written
 * against.
 *
 * COMPARED PART BY PART AS NUMBERS, never as strings: "1.10.0" sorts BELOW
 * "1.9.0" lexically, which would call the newest build in the fleet the
 * stalest one — and it would do so silently, on the release where it first
 * mattered. A version that parses to nothing (a hand-built APK naming itself
 * something else) is null as well, because guessing which side of a
 * comparison an unrecognisable string falls on is inventing a fact.
 *
 * A build AHEAD of the stated one is not behind, and says nothing. Somebody
 * testing tomorrow's APK is not a fault, and the honest reading is that the
 * office has not updated the setting yet.
 */
export function buildIsBehind(reported: string | null, current: string | null): boolean | null {
  const a = versionParts(reported);
  const b = versionParts(current);
  if (!a || !b) return null;
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i += 1) {
    const mine = a[i] ?? 0;
    const theirs = b[i] ?? 0;
    if (mine !== theirs) return mine < theirs;
  }
  return false;
}

/** "1.8.0", "1.8.0 (42)" and " 1.8 " all read as their leading dotted numbers. */
function versionParts(v: string | null): number[] | null {
  const match = /^\s*v?(\d+(?:\.\d+)*)/.exec(v ?? "");
  if (!match) return null;
  return match[1].split(".").map(Number);
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
   * THE PLATFORM REFUSED TO START THE RECORDER, and it is first because the
   * fix is one tap and nothing below it is.
   *
   * This is not a battery manager killing anything. Android 12 forbids
   * starting a foreground service from the background outside a short list of
   * exempt moments, and a phone that has not been given the battery exemption
   * is refused there by design. Drawn as "his phone stopped the tracker" it
   * would send somebody hunting through an OEM settings tree for a switch that
   * is not the problem.
   */
  const refused = ms(f.locationServiceRefusedAt ?? null);
  if (refused !== null && f.dayOpen && f.locationServiceRunning === false) {
    notes.push({
      tone: "bad",
      text: `His phone would not let MahekOne start recording — ${ageWords(refused, nowMs)} ago`,
      detail:
        "Android refuses to start a background recorder on a phone that is not exempt from battery optimisation. He fixes it in one tap on Sync → Keep tracking on, which puts up the system dialog; until he does, the route records only while the app is open.",
    });
  }

  /*
   * THE RECORDER IS DOWN, which is a different sentence from either of the two
   * around it.
   *
   * `undefined` is a build that has never heard of the service and says
   * nothing at all; `false` is a handset that has one and is not running it.
   * The refusal note above is the case where we know why, so this fires only
   * where we do not — and it is drawn as a warning rather than a fault,
   * because the watchdog starts it again within the quarter hour and a row
   * that shouts at every ordinary gap is a row nobody reads.
   *
   * THE WATCHDOG'S OWN VERDICT IS THE SECOND CASE WHERE WE KNOW WHY, and it
   * is excluded here for exactly the reason the refusal is. A phone whose
   * watchdog has caught the tracker accepted and silent reports both facts at
   * once — the service is down AND we know what took it down — and drawn
   * together this line sat ABOVE the one naming the cause, saying the recorder
   * starts itself again and his work is safe, over a handset an OEM battery
   * manager is killing. That is a reassurance contradicting the fault
   * underneath it, and the thing to act on has to come first. `trackerStalled`
   * says it better and says what to do, so it says it alone.
   */
  if (
    f.locationServiceRunning === false &&
    f.dayOpen &&
    refused === null &&
    !trackerStalled(f)
  ) {
    notes.push({
      tone: "warn",
      text: "Route recorder not running",
      detail:
        "MahekOne's own recorder is down on this handset. It starts itself again on the next wake-up, and his work is safe on the phone either way — if it stays down all day the handset needs its battery and autostart settings checked.",
    });
  }

  /*
   * IT IS UP AND IT IS NOT RECORDING, which is the failure no other column on
   * this row can see.
   *
   * A foreground service can hold its notification, keep its process alive,
   * and have a fused provider that has quietly stopped delivering — Play
   * services updated under a running app, a ROM suspending the provider
   * without touching the process. From every other angle that handset looks
   * perfect. It is a warning rather than a fault because the service re-asks
   * the provider on its own heartbeat and most of these recover unaided.
   */
  if (f.locationServiceRunning === true && f.dayOpen) {
    const lastFix = ms(f.locationServiceLastFixAt ?? null);
    if (lastFix !== null && nowMs - lastFix > t.noTrailMinutes * 60_000) {
      notes.push({
        tone: "warn",
        text: `Recorder running but no fix for ${ageWords(lastFix, nowMs)}`,
        detail:
          "The recorder is up and the phone's location provider has stopped answering it — usually Play services updating underneath, or the handset's power manager suspending the provider. It re-asks every minute on its own.",
      });
    }

    /*
     * IT IS SENDING AND NOTHING IS BEING TAKEN, which nothing could see.
     *
     * `uploads()` on the handset answers whether the recorder BELIEVES it is
     * posting — cadence set, credential held, server not refusing it, day
     * open, service up. All five survive a post that times out for ever
     * against a captive portal, or a body the far end keeps refusing for a
     * reason that is not auth. And the app reads that same belief through
     * `chooseSender` and leaves the queue alone, so the only visible symptom
     * is the buffer climbing towards `serviceBufferCap` — at which point the
     * OLDEST fixes are dropped, and a morning of somebody's route is gone.
     *
     * THE GAP IS MEASURED AT THE PHONE'S END, NOT AGAINST NOW, and that is the
     * half that makes this safe to draw. Both marks are stamped on our clock
     * inside one request, so their difference is exactly the silence the
     * handset reported and carries no drift at all. Measured against `nowMs`
     * instead it would fire on every phone whose app has simply not run for a
     * while — a recorder doing all the posting does not refresh this report,
     * so a healthy handset would accuse itself the moment its owner stopped
     * opening the app. It also means a phone out of signal cannot trip it: the
     * last thing it told us was said while it was online, when the gap was
     * small, and silence since freezes the figure rather than growing it.
     * Silence has its own line, further down, and one fact gets one sentence.
     *
     * The reading's own age is printed beside it for the reason the battery's
     * is: it is what the phone last said, never a live number.
     */
    const lastUpload = ms(f.locationServiceLastUploadAt ?? null);
    const said = ms(f.deviceStateAt);
    /* NULL IS NEVER AN ACCUSATION. A recorder that has never had a batch taken
       is the ordinary state wherever the office posts from the app instead —
       `serviceUploadEverySeconds` at zero — and there is no age to print
       beside one either way. */
    if (
      t.serviceUploadEverySeconds > 0 &&
      lastUpload !== null &&
      said !== null &&
      said - lastUpload > uploaderSilenceMs(t)
    ) {
      notes.push({
        tone: "warn",
        text: `Recorder holding its fixes — nothing sent for ${ageWords(lastUpload, said)}, read ${ageWords(said, nowMs)} ago`,
        detail:
          "The recorder is up and taking fixes, and its own sending has stopped being accepted — a captive wifi that answers every request, or a credential this handset can no longer refresh. His work is not lost: it is held on the phone and goes up whenever he opens the app. What it costs is the live map while the app is shut, and if it runs all day the oldest fixes are eventually dropped. Ask him to open MahekOne on mobile data rather than wifi; if it persists, signing out and back in is what replaces the credential.",
      });
    }
  }

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
  if (stalled !== null && trackerStalled(f)) {
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
   * IT RAN AND IT STOPPED — see `trailHasStopped`, whose note this is.
   *
   * It sits here because it is the other half of the block above it: that one
   * is a day that produced nothing, this one is a day that stopped producing,
   * and they cannot both fire. It sits ABOVE the silence line for the reason
   * that line's own comment gives — a duration belongs under something that
   * names the fault, and until this existed there was nothing for it to sit
   * under on the commonest shape of a lost route.
   *
   * WHETHER THE WORK IS LOST OR MERELY LATE IS THE WHOLE OF WHAT IT SAYS, and
   * the phone is what answers it. A handset reporting fixes still queued is a
   * handset whose route is safe and travelling: the positions exist, they are
   * on the phone, and they arrive when it gets a connection — drawn as a
   * fault, that is a manager ringing a salesman who is doing nothing wrong,
   * which is how a panel teaches people to ignore it. A handset reporting
   * nothing queued and no recent position is the opposite reading: the route
   * is not waiting anywhere we can see, and those kilometres are gone.
   *
   * Null queued is NOT read as zero, here as everywhere else on this row: a
   * build too old to report its queue has told us nothing about it, and the
   * honest answer to an unknown is the one that does not claim the work is
   * lost. It takes the softer sentence.
   */
  const stoppedAt = ms(f.trailSeenAt);
  if (stoppedAt !== null && trailHasStopped(f, t, nowMs)) {
    const holding = f.queuedPositions === null || f.queuedPositions > 0;
    notes.push({
      tone: holding ? "warn" : "bad",
      text: `Route stopped reaching us ${ageWords(stoppedAt, nowMs)} ago`,
      detail: holding
        ? "His trail ran and then stopped arriving. The phone says it is still holding fixes, so this is the sending rather than the recording — the work is on the handset and comes up as soon as it has a connection, and the map is behind rather than wrong. Nothing to do unless it stays behind all day, and note that the phone can be in constant contact with us while this is true: a batch arriving now can be carrying readings from hours ago."
        : "His trail ran and then stopped arriving, and the phone is not reporting anything held back — so unlike the line about a queue, this route is not waiting somewhere it can be recovered from. The usual cause is the phone killing the tracking service part-way through the day: ask him to allow MahekOne to autostart and to set its battery usage to unrestricted, then check out and back in. Anything else on this row naming the recorder or the permission is the fault itself; this is what it has cost so far.",
    });
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

  /*
   * HOW MUCH OF HIS DAY HAS NOT REACHED US, in plain words.
   *
   * This is the question a manager is really asking and the one nothing could
   * answer: not "is he tracking" but "is his day going to reach me". Every fix
   * waits on the phone until the server confirms it, so a handset can be
   * perfectly healthy, answering every heartbeat, and holding hours of work —
   * and until this column existed the only way to find out was to read the
   * positions table and notice the newest row was old.
   *
   * IT IS NOT A FAULT AND IS NOT DRAWN AS ONE. A queue is the design working:
   * the connection went, nothing was lost, and it will arrive. So it is
   * `info` rather than `warn`, and it is said in minutes of WORK rather than
   * in rows — "about 25 min of his route has not reached us yet" is something
   * anybody can act on, and "12,412 positions queued" is a number only the
   * person who built this can read. That is the whole rule for this panel:
   * the people reading it are managers, not engineers.
   *
   * SILENT BELOW THE THRESHOLD, like every other line here. A phone that is a
   * few fixes behind is a phone syncing normally, and a row that always says
   * something is a row nobody reads.
   *
   * The age travels with it for the same reason the battery's does: a count
   * from breakfast would have somebody chasing a queue that has long since
   * drained.
   */
  const queued = f.queuedPositions;
  if (queued !== null && queued >= Math.max(1, t.queuedPositionsWorthSaying)) {
    const readAt = ms(f.queuedPositionsAt);
    const when = readAt === null ? "" : ` — read ${ageWords(readAt, nowMs)} ago`;
    notes.push({
      tone: "info",
      text: `${queued.toLocaleString("en-IN")} fixes still on his phone${when}`,
      detail:
        "His phone records every position and keeps it until we confirm we have it, so none of this is lost — it is waiting for a connection. It arrives on its own, usually within minutes of him getting signal or opening the app. Worth a look only if the number keeps growing all day.",
    });
  }

  /*
   * AN OLD BUILD, LAST — and last is where it belongs rather than an oversight.
   *
   * Nothing above it is undone by an update and nothing below it is waiting on
   * one; this is the line that explains the OTHERS. A phone three releases back
   * does not report half the columns this panel reads, so its row is quiet not
   * because the handset is well but because that build has nothing to say — and
   * a manager who does not know which build a man is on reads that silence as
   * health. Two of the three handsets in the field on the day this was written
   * were on 1.6.1 and 1.1.0 against a published 1.8.0, and no screen in
   * MahekOne said so; the build was on the row's hover title and nowhere else,
   * which is the same as nowhere.
   *
   * It is NOT gated on an open day. A build is stale in a drawer at midnight
   * exactly as it is stale on a beat, and the evening — when somebody is
   * reading back over the day rather than chasing it — is when anybody has
   * time to go and get a phone updated.
   *
   * `warn` rather than `bad`: an old build still records a day, sends its
   * visits and takes its orders. What it loses is the newest of what it could
   * tell us about itself, which is a hole in this panel rather than in his
   * work. Silent where either version is unknown — see `buildIsBehind`.
   */
  if (buildIsBehind(f.appVersion, t.currentAppVersion)) {
    notes.push({
      tone: "warn",
      text: `Running MBOS ${f.appVersion} — ${t.currentAppVersion} is out`,
      detail:
        "An old build still records his day and still sends it; what it cannot do is report everything newer builds report about themselves, so the rest of this row may be quieter than the phone actually deserves. He updates from the download link the office gives out — and if a handset stays behind for weeks it is usually because the update was never installed rather than never offered.",
    });
  }

  return notes;
}
