import Link from "next/link";
import { APP_TIMEZONE } from "@/lib/business-date";
import type { ActivityPoint, LastKnown, TrackPoint } from "@/lib/services/sales-service";
import { activityLabel } from "@/lib/mbos/activity-labels";

/**
 * The map.
 *
 * **There are no tiles under it, and the design never asked for any.** What is
 * drawn is the team's own bounding box with a grid over it — so a pin's place
 * on the canvas is its place relative to everybody else, which is the question
 * a manager is actually asking when they open this: who is out east, who is
 * bunched together, who is nowhere near their beat. Streets would mean sending
 * the coordinates of Mahek's salesmen to whoever supplies them, on every
 * render, plus a key and a bill, to answer a question they were not being
 * asked.
 *
 * **Longitude is squeezed by cos(latitude)**, or a Nagpur day comes out about a
 * fifth too wide and the whole team looks strung out east-to-west.
 *
 * **A pin is only drawn where there is a fix.** The design mock spaces every
 * salesman out arithmetically — `left: 12 + i * 15 % 76` — which is fine for a
 * picture of a screen and would be a lie on a real one. Somebody with no fix
 * today has no position, so they appear in the team list saying exactly that
 * and nowhere on the canvas. Inventing a spot for them is the one thing a map
 * of where people are must not do.
 */

const PIN = 34;

/**
 * The canvas's own shape, width over height.
 *
 * A FIXED ratio rather than the design's fixed 440px height, and the reason is
 * the projection: fitting a real bounding box into a box whose shape is not
 * known until it is on screen means either stretching the map to fill it — a
 * day that ran six kilometres north and five hundred metres east drawn as a
 * square — or guessing. Pinning the ratio makes the fit exact and costs a
 * canvas that is taller on a narrow window, which is what anybody would want
 * there anyway.
 */
const ASPECT = 2.4;

export function MapCanvas({
  rows,
  tracks,
  activity,
  staleAfterSeconds,
  view,
}: {
  rows: LastKnown[];
  /** Present only in the `today` view — one polyline per salesman. */
  tracks: Map<string, TrackPoint[]>;
  /** Where each thing was done. Marked along the trail in the `today` view. */
  activity: ActivityPoint[];
  /** Beyond this, a fix is called stale rather than dropped. Configuration. */
  staleAfterSeconds: number;
  view: "now" | "today";
}) {
  const pinned = rows.filter((r) => r.lat != null && r.lng != null);

  /* The box is drawn around everything being shown, which in the `today` view
     is the whole day's travel and not just where each person ended up. A box
     around the last fixes alone would push the morning off the canvas. */
  const marks = view === "today" ? activity : [];
  const lats = [
    ...pinned.map((r) => r.lat as number),
    ...[...tracks.values()].flat().map((p) => p.lat),
    ...marks.map((a) => a.lat),
  ];
  const lngs = [
    ...pinned.map((r) => r.lng as number),
    ...[...tracks.values()].flat().map((p) => p.lng),
    ...marks.map((a) => a.lng),
  ];

  const box = boundsOf(lats, lngs);

  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div
        className="relative min-h-[320px] bg-[#F0F2F6]"
        style={{ aspectRatio: String(ASPECT) }}
      >
        {/* The grid. It carries no scale of its own — the scale bar does that,
            because a grid line that means nothing is furniture and a grid line
            that means a kilometre had better be a kilometre. */}
        <span className="absolute inset-x-0 top-1/3 h-px bg-line" />
        <span className="absolute inset-x-0 top-2/3 h-px bg-line" />
        <span className="absolute inset-y-0 left-[30%] w-px bg-line" />
        <span className="absolute inset-y-0 left-[64%] w-px bg-line" />

        {box && view === "today" && tracks.size ? (
          <Trails tracks={tracks} box={box} />
        ) : null}

        {/* The work, marked along the day. An order taken two kilometres off
            the beat is obvious on a line and invisible in a list — which is
            the whole reason every activity now records where it happened. */}
        {box
          ? marks.map((a) => {
              const at = project(a.lat, a.lng, box);
              const stale = (a.ageSeconds ?? 0) > staleAfterSeconds;
              return (
                <span
                  key={`${a.entityType}:${a.entityId}`}
                  title={`${activityLabel(a.entityType)} — ${clock(a.capturedAt)}${
                    a.accuracyM ? `, ±${a.accuracyM} m` : ""
                  }${stale ? `, position ${Math.round((a.ageSeconds ?? 0) / 60)} min old` : ""}`}
                  style={{
                    left: `calc(${at.x * 100}% - 4px)`,
                    top: `calc(${at.y * 100}% - 4px)`,
                    /* A stale fix is drawn hollow rather than hidden. It is a
                       real record of a real act; what is uncertain is only
                       where, and the outline says so without deleting it. */
                    background: stale ? "transparent" : "#3D14A8",
                    borderColor: "#3D14A8",
                  }}
                  className="absolute size-2 rounded-[1px] border"
                />
              );
            })
          : null}

        {box
          ? pinned.map((r) => {
              const at = project(r.lat as number, r.lng as number, box);
              return (
                <Link
                  key={r.salesmanId}
                  href={`/sales/people/${r.salesmanId}`}
                  title={`${r.salesmanName} — ${r.place ?? "on the road"}, ${clock(r.seenAt)}`}
                  style={{
                    left: `calc(${at.x * 100}% - ${PIN / 2}px)`,
                    top: `calc(${at.y * 100}% - ${PIN / 2}px)`,
                    width: PIN,
                    height: PIN,
                    background: pinColour(r),
                    color: r.onLeave ? "#6B7385" : "#FFFFFF",
                    boxShadow: "0 2px 8px rgba(22,22,22,0.18)",
                  }}
                  className="absolute flex items-center justify-center rounded-full border-2 border-white text-[12px] font-semibold no-underline hover:no-underline"
                >
                  {r.initials}
                </Link>
              );
            })
          : null}

        {!box ? (
          <div className="absolute inset-0 flex items-center justify-center px-8 text-center">
            <div>
              <div className="text-[17px] font-semibold text-ink">Nothing to place yet</div>
              <p className="mx-auto mt-1 max-w-[420px] text-pretty text-sm text-muted">
                No handset has sent a position today, so there is nothing to draw. Everybody is
                still listed beside this, with what is known about each of them.
              </p>
            </div>
          </div>
        ) : null}

        {/* Bottom left, exactly where the design puts it. */}
        <span className="absolute bottom-4 left-4 flex gap-3.5 rounded-[4px] border border-line bg-surface px-3 py-2">
          <Key colour="#6835FB" label="Tracking" />
          <Key colour="#B3261E" label="No signal" />
          <Key colour="#C2C8D2" label="On leave" />
          {view === "today" && marks.length ? (
            <Key colour="#3D14A8" label={`${marks.length} logged`} square />
          ) : null}
        </span>

        {box ? (
          <span className="absolute right-4 bottom-4 rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-[12px] text-muted">
            {box.label} across
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The day each salesman walked, behind the pins.
 *
 * One SVG rather than one per person: eleven overlapping absolutely-positioned
 * layers is eleven stacking contexts to reason about, and the lines have to be
 * able to cross each other.
 */
function Trails({
  tracks,
  box,
}: {
  tracks: Map<string, TrackPoint[]>;
  box: Bounds;
}) {
  return (
    <svg
      /* The fractions are ALREADY letterboxed by `project`, so this stretches a
         unit square onto the canvas and the lines land exactly where the pins
         do. Doing the fitting here instead would mean two projections that
         have to agree, which is two projections that eventually do not. */
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    >
      {[...tracks].map(([salesmanId, points]) => {
        if (points.length < 2) return null;
        const d = points
          .map((p, i) => {
            const at = project(p.lat, p.lng, box);
            return `${i === 0 ? "M" : "L"}${(at.x * 1000).toFixed(1)},${(at.y * 1000).toFixed(1)}`;
          })
          .join(" ");
        return (
          <path
            key={salesmanId}
            d={d}
            fill="none"
            stroke="#6835FB"
            strokeOpacity={0.45}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

function Key({
  colour,
  label,
  square,
}: {
  colour: string;
  label: string;
  /* Activities are squares and people are circles, so the two never read as
     the same kind of thing at a glance. */
  square?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-body">
      <span
        className={square ? "block size-2 rounded-[1px]" : "block size-2 rounded-full"}
        style={{ background: colour }}
      />
      {label}
    </span>
  );
}

/**
 * The team, beside the map.
 *
 * Everybody, including whoever has no pin — a salesman missing from both the
 * canvas and the list is a salesman nobody notices is missing, which is the
 * opposite of what this screen is for. The dot repeats what the pin colour
 * says, because the row is read on its own as often as beside the map.
 */
export function TeamList({ rows }: { rows: LastKnown[] }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="border-b border-divider px-4 py-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        The team
      </div>
      {rows.map((r) => (
        <Link
          key={r.salesmanId}
          href={`/sales/people/${r.salesmanId}`}
          className="flex w-full items-center gap-2.5 border-t border-[#F7F8FA] px-4 py-3 text-left no-underline first:border-t-0 hover:bg-canvas hover:no-underline"
        >
          <span className="flex size-7 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
            {r.initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                className="block size-2 flex-none rounded-full"
                style={{ background: dotColour(r) }}
              />
              <span className="truncate text-sm font-medium text-ink">{r.salesmanName}</span>
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-muted">{whereLine(r)}</span>
            <span className="block text-[12px] text-muted">{seenLine(r)}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- the words */

/**
 * What the row says under the name.
 *
 * A fix taken between two shops has no place name, and reverse-geocoding one
 * would be a guess printed as a fact. "On the road" is the truth, and it is
 * also the more useful sentence: it says he is moving.
 */
function whereLine(r: LastKnown): string {
  if (r.onLeave) return "On approved leave";
  if (!r.checkInAt) return "Not checked in";
  if (r.place === "Checked in") return "At the day's start point";
  return r.place ?? "On the road";
}

function seenLine(r: LastKnown): string {
  if (!r.seenAt) return "No fix today";
  return `Last seen ${clock(r.seenAt)}`;
}

function pinColour(r: LastKnown): string {
  if (r.onLeave) return "#EDEFF3";
  return r.checkInAt && !r.checkOutAt ? "#6835FB" : "#B3261E";
}

function dotColour(r: LastKnown): string {
  if (r.onLeave) return "#C2C8D2";
  return r.checkInAt && !r.checkOutAt ? "#1D7A45" : "#B3261E";
}

/* ---------------------------------------------------------- the projection */

type Bounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  squeeze: number;
  /** Canvas units per metre, one scale for both axes so shape is preserved. */
  scale: number;
  /** The letterbox margins that centre the drawing in the canvas. */
  offsetX: number;
  offsetY: number;
  label: string;
};

/**
 * The box everything is drawn in.
 *
 * **A degenerate box is padded rather than divided by.** One salesman, or a
 * whole team standing in one market, gives a span of zero — and a projection
 * that divides by it puts everybody at NaN, which renders as nothing at all
 * with no error anywhere. The pad is 300 metres, so one person lands in the
 * middle of a canvas that says 300 m across rather than in a corner of one
 * claiming to span a state.
 */
function boundsOf(lats: number[], lngs: number[]): Bounds | null {
  if (!lats.length || !lngs.length) return null;

  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);

  const squeeze = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)) || 1;
  const PAD_M = 300;
  const padLat = PAD_M / 111_320;
  const padLng = PAD_M / (111_320 * squeeze);

  /* Always padded, not only when degenerate: a pin is 34px wide and sits on
     its coordinate, so anybody at the very edge of the box would be drawn half
     outside the canvas. A single fix — one salesman, or a whole team standing
     in one market — would otherwise give a span of zero, and dividing by it
     puts everybody at NaN, which renders as an empty canvas with no error
     anywhere. */
  minLat -= padLat;
  maxLat += padLat;
  minLng -= padLng;
  maxLng += padLng;

  const metresWide = (maxLng - minLng) * 111_320 * squeeze;
  const metresTall = (maxLat - minLat) * 111_320;

  /* Fit, do not fill. One scale for both axes so the day keeps its shape, and
     whatever is left over becomes margin — the alternative is stretching the
     box to the canvas, which draws a six-kilometre walk north and a five
     hundred metre step east as a square and quietly makes every day look
     like the same day. */
  const scale = Math.min(ASPECT / metresWide, 1 / metresTall);
  const drawnW = metresWide * scale;
  const drawnH = metresTall * scale;

  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    squeeze,
    scale,
    offsetX: (ASPECT - drawnW) / 2,
    offsetY: (1 - drawnH) / 2,
    label: distance(metresWide),
  };
}

/**
 * Where a coordinate falls on the canvas, as a 0–1 fraction of each side.
 *
 * Metres first, then the letterbox — so the same function answers for a pin
 * and for a point on a trail, and the two cannot drift apart.
 */
function project(lat: number, lng: number, box: Bounds): { x: number; y: number } {
  const eastM = (lng - box.minLng) * 111_320 * box.squeeze;
  const southM = (box.maxLat - lat) * 111_320;
  return {
    x: (box.offsetX + eastM * box.scale) / ASPECT,
    /* y grows downward and latitude grows northward, so it is inverted above. */
    y: box.offsetY + southM * box.scale,
  };
}

/** A round number a person can hold: 500 m, 2 km, 50 km. */
function distance(metres: number): string {
  if (metres >= 1000) {
    const km = metres / 1000;
    return `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`;
  }
  return `${Math.max(50, Math.round(metres / 50) * 50)} m`;
}

/** Named, because this renders on a server that is not in Asia/Kolkata. */
function clock(at: Date | string | null): string {
  if (!at) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
