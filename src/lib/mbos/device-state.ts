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

export type DeviceState = {
  locationPermission?: LocationPermission;
  locationServicesEnabled?: boolean;
  connectionType?: ConnectionType;
  batteryPercent?: number;
  batteryCharging?: boolean;
  deviceStateAt?: Date;
};

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

  return state;
}
