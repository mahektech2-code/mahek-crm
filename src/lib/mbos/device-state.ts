/**
 * WHAT A HANDSET SAYS ABOUT ITSELF, read in ONE place.
 *
 * Two endpoints accept this and they accept it identically: the permission
 * report, which fires when `trail.start()` discovers what the OS actually
 * granted, and the position batch, which is already talking every few minutes
 * while a day is open and is therefore the cheapest carrier there is for a
 * battery reading — no extra request, no extra radio, no extra drain on the
 * very battery being reported.
 *
 * Two copies of this parsing would drift, and the half that drifts is the half
 * that silently stops recording: an unknown string quietly dropped on one path
 * and stored on the other is a column that means different things depending on
 * which endpoint happened to write it.
 *
 * PURE, and it performs no I/O, so the refusals below can be tested without a
 * database or a phone.
 */

/** The OS's own four answers about location. Anything else is not an answer. */
export const LOCATION_PERMISSIONS = [
  /** "Allow all the time" — the only one that survives a locked screen. */
  "always",
  /** "While using the app" — the trail dies the moment the phone locks. */
  "while_using",
  /** Refused, or revoked in settings later. */
  "denied",
  /** Nobody has been asked yet. NOT the same as this build not reporting. */
  "undetermined",
] as const;

export type LocationPermission = (typeof LOCATION_PERMISSIONS)[number];

/** What it was connected BY. Never a claim about being disconnected. */
export const CONNECTION_TYPES = ["wifi", "cellular", "none", "unknown"] as const;

export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/**
 * WHETHER THE PHONE'S OWN BATTERY MANAGER WILL LET MBOS KEEP RUNNING.
 *
 * Every other reading here answers "was the app allowed to"; this one answers
 * "and did the phone let it", and it is the difference between the two that
 * this whole subsystem keeps failing on. Three handsets in the field report
 * `tracker_stalled_at` with every permission reading `always`, location
 * services on and the background grant genuinely held — because vivo's Funtouch
 * kills the foreground service the trail runs in whatever any of that says. The
 * office had no column that could express it, so the Live map could say a phone
 * had stopped and never why.
 *
 * TWO VALUES, NEVER "unknown". The handset sends nothing at all where it cannot
 * check — iOS, an older APK, a ROM that refuses — and the absent-is-not-null
 * rule below then leaves the stored answer alone. A third value meaning "could
 * not check" would overwrite a real answer with the absence of one, which is
 * the same failure "unknown is not exempt" already names on the handset.
 */
export const BATTERY_EXEMPTIONS = [
  /** Android is leaving the app alone. */
  "exempt",
  /** Doze and app standby are free to kill the tracker's foreground service. */
  "optimised",
] as const;

export type BatteryExemption = (typeof BATTERY_EXEMPTIONS)[number];

export type DeviceState = {
  locationPermission?: LocationPermission;
  locationServicesEnabled?: boolean;
  connectionType?: ConnectionType;
  batteryPercent?: number;
  batteryCharging?: boolean;
  batteryExemption?: BatteryExemption;
  backgroundSyncRegistered?: boolean;
  /**
   * `null` is a CLEAR and absent is still "leave it alone" — the two used to
   * be the same thing and could only ever set the column, never unset it. See
   * the note where they are read.
   */
  backgroundSyncLastRunAt?: Date | null;
  trackerStalledAt?: Date | null;
  /** Unsent fixes still on the phone. Zero is a real answer; absent is not. */
  queuedPositions?: number;
  queuedPositionsAt?: Date;
  /**
   * MBOS'S OWN RECORDER. Absent on every handset whose build predates it,
   * which is all of them until somebody installs the next APK — and absent is
   * never read as "not running".
   */
  locationServiceRunning?: boolean;
  locationServiceLastFixAt?: Date | null;
  /**
   * WHEN A BATCH WAS LAST ACCEPTED — the only reading here taken at OUR end.
   *
   * Everything else on this row is the phone's account of itself. This mark is
   * written where the server said yes, which is what makes it the one thing
   * that can tell a recorder that IS sending from one that merely believes it
   * is. Null is a recorder that has never had one taken, which on a deployment
   * that posts from the app rather than from the service is every handset.
   */
  locationServiceLastUploadAt?: Date | null;
  locationServiceBuffered?: number;
  locationServiceStartsToday?: number;
  locationServiceRefusedAt?: Date | null;
  locationServiceRefusal?: string;
  deviceStateAt?: Date;
};

/**
 * A duration the handset reports, turned into an instant on OUR clock.
 *
 * The rule everywhere else here is the server's clock and never the phone's,
 * because a phone's clock is its owner's to set. It cannot be followed
 * literally for "when did the background task last run" — that is a fact only
 * the handset holds. A duration is the way out: an absolute instant from a
 * phone two hours fast is two hours wrong, while seconds-ago is exposed only
 * to drift across the interval itself.
 *
 * A NEGATIVE is refused rather than clamped. It means the handset measured a
 * gap ending in its own future, which is a clock that moved under it, and the
 * honest answer to that is to say nothing rather than to stamp `now` and let a
 * screen call it fresh. The cap is a fortnight for the same reason: past that
 * the reading answers no question anybody is asking, and a number that large
 * is far likelier to be arithmetic on a corrected clock than a real silence.
 */
const FOURTEEN_DAYS_S = 14 * 24 * 60 * 60;

function instantFromAgo(v: unknown): Date | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (v < 0 || v > FOURTEEN_DAYS_S) return undefined;
  return new Date(Date.now() - Math.round(v) * 1000);
}

/**
 * Was the key THERE, carrying null — as opposed to never sent at all?
 *
 * The one question `instantFromAgo` cannot answer, because both arrive as
 * `undefined` by the time it sees a value. A handset saying "there is no stall"
 * and a handset that cannot say are different facts about a phone, and only
 * the first of them should clear a column.
 */
function isPresentNull(body: Record<string, unknown>, key: string): boolean {
  return key in body && body[key] === null;
}

const oneOf = <T extends string>(all: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : undefined;

/**
 * The fields that actually arrived, and only those.
 *
 * ABSENT IS NOT NULL. Every key is omitted rather than set to null when the
 * handset did not send it, so spreading the result into a Drizzle `.set()`
 * leaves the stored column exactly as it was. That is what lets a handset
 * still running the old build post its boolean without wiping the richer
 * answers a newer one has already given for the same phone — and it is the
 * same reason an APK that sends a column this server does not know about has
 * that column dropped rather than the row refused.
 *
 * A value that is present but WRONG — a battery of 140, a permission spelled
 * differently — is dropped for the same reason, rather than stored and left
 * for a screen to render. The check constraints behind these columns would
 * refuse it anyway, and refusing the whole report over one bad field would
 * lose the good ones beside it.
 */
export function readDeviceState(body: Record<string, unknown>): DeviceState {
  const state: DeviceState = {};

  const permission = oneOf(LOCATION_PERMISSIONS, body.locationPermission);
  if (permission) state.locationPermission = permission;

  if (typeof body.locationServicesEnabled === "boolean") {
    state.locationServicesEnabled = body.locationServicesEnabled;
  }

  const connection = oneOf(CONNECTION_TYPES, body.connectionType);
  if (connection) state.connectionType = connection;

  /* Rounded here rather than trusted: expo-battery answers a fraction, and a
     handset is free to send whatever it likes to a URL. */
  if (typeof body.batteryPercent === "number" && Number.isFinite(body.batteryPercent)) {
    const percent = Math.round(body.batteryPercent);
    if (percent >= 0 && percent <= 100) state.batteryPercent = percent;
  }

  if (typeof body.batteryCharging === "boolean") {
    state.batteryCharging = body.batteryCharging;
  }

  /* The word or nothing. An unrecognised string is dropped rather than stored,
     the same as a permission spelled differently — a screen is going to draw
     this, and a figure a screen draws has to have come from somewhere. */
  const exemption = oneOf(BATTERY_EXEMPTIONS, body.batteryExemption);
  if (exemption) state.batteryExemption = exemption;

  /*
   * HOW FAR BEHIND THE PHONE IS, which is the number managers actually ask for.
   *
   * Not "is he tracking" but "is his day going to reach me". Zero IS a real
   * answer here and the common one — the handset is clear — so unlike the marks
   * below this is stored whenever it arrives, and it is absence rather than
   * zero that means "this build cannot say".
   *
   * A negative or a fraction is dropped rather than rounded into something
   * plausible, for the reason every other reading here is: a figure a screen
   * will draw has to have come from somewhere.
   */
  if (typeof body.queuedPositions === "number" && Number.isFinite(body.queuedPositions)) {
    const queued = Math.round(body.queuedPositions);
    if (queued >= 0) state.queuedPositions = queued;
  }

  /* Whether the OS accepted the periodic wake-up at all. False is a real
     answer and the one worth having: it is a handset that will never sync
     with the app shut, and it looked identical to a working one until this
     column existed. */
  if (typeof body.backgroundSyncRegistered === "boolean") {
    state.backgroundSyncRegistered = body.backgroundSyncRegistered;
  }

  /*
   * AN EXPLICIT NULL IS A CLEAR, AND AN ABSENT KEY IS STILL NOT.
   *
   * "Absent is not null" above is the rule that lets an old build post its one
   * boolean without wiping a newer build's richer answers, and it stays. What
   * it could not express is a condition ENDING: a handset whose tracker
   * recovered, or which was reinstalled, simply stopped sending the field, and
   * a mark once written could never be taken off. A phone fixing to three
   * metres every three seconds went on reading "his phone stopped the tracker"
   * from a timestamp belonging to a previous installation — and the panel
   * these feed is built on the discipline that a healthy handset says nothing,
   * which two permanent false alarms destroy.
   *
   * JSON tells null from missing, so the handset now sends `null` for "I can
   * report this and there is nothing to report" and omits the key only when it
   * genuinely cannot say. `in` rather than a truthiness test, because that is
   * the only check that separates the two.
   */
  const ranAgo = instantFromAgo(body.backgroundSyncLastRunAgoSeconds);
  if (ranAgo) state.backgroundSyncLastRunAt = ranAgo;
  else if (isPresentNull(body, "backgroundSyncLastRunAgoSeconds")) {
    state.backgroundSyncLastRunAt = null;
  }

  const stalledAgo = instantFromAgo(body.trackerStalledAgoSeconds);
  if (stalledAgo) state.trackerStalledAt = stalledAgo;
  else if (isPresentNull(body, "trackerStalledAgoSeconds")) {
    state.trackerStalledAt = null;
  }

  /*
   * MBOS'S OWN RECORDER, read on exactly the terms everything above it is.
   *
   * A boolean that arrived is stored; one that did not is left alone, so an
   * older handset's report cannot wipe what a newer one said about the same
   * phone. The two DURATIONS follow the `trackerStalledAt` rule one paragraph
   * up rather than the `queuedPositions` rule: an explicit `null` is the
   * handset saying "I can report this and there is nothing to report" and
   * clears the column, while an absent key means "I cannot say" and leaves it.
   * That distinction is what stopped a stall mark from surviving a reinstall,
   * and it matters here for the same reason — a phone that has been given the
   * battery exemption stops being refused, and a refusal nobody can clear is a
   * standing false alarm on a panel whose whole discipline is that a healthy
   * handset says nothing.
   *
   * ZERO IS A REAL ANSWER for the two counts and the common one: nothing
   * buffered, and a recorder that has been started once today and stayed up.
   * So they follow `queuedPositions` — stored whenever they arrive, and it is
   * absence rather than zero that means the build cannot say.
   */
  if (typeof body.locationServiceRunning === "boolean") {
    state.locationServiceRunning = body.locationServiceRunning;
  }

  const fixAgo = instantFromAgo(body.locationServiceLastFixAgoSeconds);
  if (fixAgo) state.locationServiceLastFixAt = fixAgo;
  else if (isPresentNull(body, "locationServiceLastFixAgoSeconds")) {
    state.locationServiceLastFixAt = null;
  }

  /* THE SAME RULE AS THE FIX MARK ABOVE, and it matters here for the same
     reason: a handset reinstalled, or handed to somebody else, starts with a
     recorder that has never had a batch taken — and a mark nobody can clear is
     a standing figure on a panel whose whole discipline is that a healthy phone
     says nothing. An absent key still leaves the column alone, so an older
     build that has never heard of this cannot wipe it. */
  const uploadAgo = instantFromAgo(body.locationServiceLastUploadAgoSeconds);
  if (uploadAgo) state.locationServiceLastUploadAt = uploadAgo;
  else if (isPresentNull(body, "locationServiceLastUploadAgoSeconds")) {
    state.locationServiceLastUploadAt = null;
  }

  if (
    typeof body.locationServiceBuffered === "number" &&
    Number.isFinite(body.locationServiceBuffered)
  ) {
    const buffered = Math.round(body.locationServiceBuffered);
    if (buffered >= 0) state.locationServiceBuffered = buffered;
  }

  if (
    typeof body.locationServiceStartsToday === "number" &&
    Number.isFinite(body.locationServiceStartsToday)
  ) {
    const starts = Math.round(body.locationServiceStartsToday);
    if (starts >= 0) state.locationServiceStartsToday = starts;
  }

  const refusedAgo = instantFromAgo(body.locationServiceRefusedAgoSeconds);
  if (refusedAgo) state.locationServiceRefusedAt = refusedAgo;
  else if (isPresentNull(body, "locationServiceRefusedAgoSeconds")) {
    state.locationServiceRefusedAt = null;
  }

  /* The platform's own word for it, capped rather than trusted: a handset is
     free to send whatever it likes to a URL, and this one is drawn on a screen.
     A long string is truncated rather than dropped, because the first part of
     an exception class name is the useful part. */
  if (typeof body.locationServiceRefusal === "string" && body.locationServiceRefusal.trim()) {
    state.locationServiceRefusal = body.locationServiceRefusal.trim().slice(0, 120);
  }

  /*
   * THE SERVER'S CLOCK, NEVER THE HANDSET'S.
   *
   * The same rule `mbos_visits` follows for anything anybody is paid on: a
   * phone's clock is its owner's to set. Nothing here is paid on, but a
   * battery reading stamped from a handset an hour fast would be drawn as
   * fresher than a reading taken since, and the whole point of this column is
   * that a screen can say how old the figure is.
   *
   * It is stamped only where something was actually reported — a report
   * carrying no readings gets no timestamp, so "we heard nothing" cannot come
   * to look like "we heard, and it was nothing".
   */
  if (Object.keys(state).length > 0) state.deviceStateAt = new Date();

  /* The queue depth carries its OWN age, and a check constraint refuses the
     count without it. It is stamped separately from `deviceStateAt` because a
     report can carry a battery reading and no queue depth — an older build —
     and dating the count off the report would say we had been told something
     we had not. */
  if (state.queuedPositions !== undefined) state.queuedPositionsAt = new Date();

  return state;
}
