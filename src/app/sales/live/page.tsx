import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { dropInaccurateFixes } from "@/lib/engines/trail-gaps";
import { nowMs, shortDateWithYear } from "@/lib/format";
import { trackerStalled, trailHasGaps, trailIsDead } from "@/lib/handset-health";
import { today } from "@/lib/recompute";
import { readSecret } from "@/lib/secrets";
import {
  activityPointsForDay,
  lastKnownPositions,
  tracksForDay,
} from "@/lib/services/sales-service";
import { Banner, ScreenHeader } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { LivePanel } from "./live-panel";

export const metadata = { title: "Live map — Sales Dashboard — MahekOne" };

/**
 * Where the team is, and where they have been.
 *
 * **Two views, because they answer two questions.** "Where they are now" is the
 * morning question — is anybody still at home, who is nowhere near their beat.
 * "Everywhere they went today" is the evening one: a beat walked from one end
 * to the other looks nothing like an afternoon spent in one place, and neither
 * is visible in a list of visits.
 *
 * **The map has streets under it, from Ola Maps.** The key is read once,
 * here, and handed down as a plain prop — the one credential in MahekOne
 * that has to reach the browser, because a browser is what asks a tile
 * server for squares of map. See `street-map.tsx` for why that is a
 * deliberate exception to how every other key in `app_secrets` is read, and
 * for what the SAME key also does for the "today" trail (Snap-to-Road).
 *
 * **A pin is only drawn where there is a fix.** Nobody is placed by arithmetic;
 * somebody with no position appears in the team list saying so and nowhere on
 * the canvas.
 *
 * **The shops around the team are drawn underneath, in the colours
 * Territory uses.** Everything within `mbos.location.nearbyBookRadiusKm` of
 * where each man actually is — direct customers, leads and third-party shops
 * apart by colour — so a trail reads against what it went past rather than
 * against blank streets. A catchment and not the book: the whole book at
 * national scale answers nothing, and Territory is the screen for reading
 * it. Fetched by the map itself, from `/api/sales/book-pins`, and not handed
 * down from here. That was originally because this page re-ran every thirty
 * seconds and re-serialised everything it handed down; it no longer does — the
 * map is TOLD what has arrived rather than asked for the day again, see
 * `live-panel.tsx` — and the reasoning survives the change intact: the shops do
 * not move, so they have no business on a channel built for things that do.
 *
 * The trail is a fix every few minutes between the punch-in and the punch-out;
 * the punch-in and each visit leave one apiece regardless, so somebody whose
 * tracking is off or whose permission was refused still appears. The time shown
 * is the time of the fix and never "now" — somebody who checked in at nine and
 * has had no signal since reads as nine o'clock, which is the honest thing.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; view?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;
  const view = params.view === "today" ? "today" : "now";
  const isToday = day === now;

  const [rows, config, olaMapsKey] = await Promise.all([
    lastKnownPositions(day),
    getConfig(),
    readSecret("olamaps.apiKey"),
  ]);
  const tracking = config["mbos.location.trackWhileWorking"];
  const everySeconds = config["mbos.location.trackEverySeconds"];
  const everyWords =
    everySeconds < 60 ? plural(everySeconds, "second") : plural(Math.round(everySeconds / 60), "minute");

  /* Only fetched for the view that draws it. The `now` view needs one row per
     person; the trails are a hundred times that, and paying for them to render
     a screen that does not show them is the sort of cost nobody ever finds. */
  const [tracks, activity] =
    view === "today"
      ? await Promise.all([tracksForDay(day), activityPointsForDay(day)])
      : [new Map(), []];

  /* A fix the handset itself rated as imprecise is dropped before any of
     this runs — see `dropInaccurateFixes`. One 300-metre-radius fix between
     two tight ones invents a hop nobody actually covered, which shows up as
     a phantom gap, a wrong direction arrow, and a distance that never
     happened. This is the same threshold `mbos.location.gpsAccuracyThresholdM`
     already applies to visit verification; it is filtered out here rather
     than corrected, because the trail shows only what is known. */
  const accuracyThreshold = config["mbos.location.gpsAccuracyThresholdM"];
  for (const [id, points] of tracks) {
    tracks.set(id, dropInaccurateFixes(points, accuracyThreshold));
  }

  /* "Distance" is the trail's own length, the same honesty rule
     `today-tab.tsx` uses — the sum of the gaps between consecutive fixes,
     never a straight line from start to end. Dwell stops are read off the
     same trail: a run of fixes that never drifted, held long enough to be
     more than a red light. Both are derived here, once, rather than inside
     the client map component, which redraws on every selection change. */
  /* THE DISTANCE AND THE DWELL STOPS ARE DERIVED IN THE BROWSER NOW, and they
     had to move. Both were worked out here, once per thirty-second re-render of
     this whole component — and this component does not re-render any more: the
     map is TOLD what has arrived rather than asked for the day again (see
     `live-panel.tsx`). A figure derived here would sit frozen beside a line that
     grew all afternoon, which is the same bug this change was made to fix,
     wearing a different costume. Both are pure engines — `trailMetres` and
     `dwellStops` — so the browser runs the same two functions over the same
     points and gets the same answers. What this page still owns is the BANNERS
     below, which are a reading of the team as the screen was opened. */

  const out = rows.filter((r) => r.checkInAt && !r.checkOutAt && !r.onLeave);
  const noSignal = rows.filter((r) => !r.seenAt && !r.onLeave);
  /* `trailHasGaps` rather than the raw boolean, so the banner counts exactly
     the rows that explain themselves underneath — see its own comment. Null is
     never counted: it means the handset has not reported, which is not the
     same claim as "refused". */
  const noBackgroundTracking = rows.filter((r) => trailHasGaps(r) && !r.onLeave);
  /* Read once and shared, so the banner and every row beneath it are counting
     against the same instant — and because the React Compiler rule this
     codebase runs under forbids the client half reading a clock at all. */
  const clockMs = nowMs();
  /* A HANDSET REPORTING PERFECTLY AND PRODUCING NO TRAIL is its own count and
     its own sentence, because it is nothing like the row above it: those are
     phones whose trail has holes, and these are phones that have not produced
     one. It is asked only of TODAY — "checked in 4 hr ago" measured against
     this afternoon's clock says nothing whatever about a Tuesday in March, and
     a day left open by a forgotten punch-out would read as a fault for ever. */
  const deadTrail = isToday
    ? rows.filter(
        (r) =>
          !r.onLeave &&
          trailIsDead(
            { ...r, dayOpen: Boolean(r.checkInAt && !r.checkOutAt) },
            { noTrailMinutes: config["mbos.location.noTrailMinutes"] },
            clockMs,
          ),
      )
    : [];

  /* THE PHONE ITSELF SAYING ITS TRACKER IS STOPPED, counted as its own thing.
     It is not the row above: `deadTrail` is inferred here from an absence of
     positions, and this is the handset's own watchdog reporting the tracker
     accepted and delivering nothing — a fact the phone established and sent,
     which no amount of reading the positions table could establish as
     confidently. In production all three live handsets carried it for three
     days with nothing on any screen counting them, which is how a banner comes
     to be the thing that was missing rather than the row note underneath it.
     Today only, for the same reason `deadTrail` is: a stall reported this
     afternoon says nothing whatever about a Tuesday in March. */
  const stalled = isToday
    ? rows.filter((r) => !r.onLeave && trackerStalled({ ...r, dayOpen: Boolean(r.checkInAt && !r.checkOutAt) }))
    : [];

  return (
    <div className="p-6">
      <ScreenHeader
        title="Live map"
        subtitle={
          isToday
            ? view === "now"
              ? "Where everyone is right now. Tracking runs only while a salesman is checked in, so a missing pin usually means an unstarted day."
              : "Every position each salesman has reported today, in the order it arrived, with the work marked along it. The shape of a day says more than a count of visits does."
            : view === "now"
              ? `Each salesman's last reported position on ${shortDateWithYear(day, now)}. A missing pin means no fix was ever recorded that day.`
              : `Every position each salesman reported on ${shortDateWithYear(day, now)}, in the order it arrived, with the work marked along it.`
        }
        actions={
          <div className="flex flex-none items-center gap-2">
            {/* A day, not a month — see the comment on `Mode` for why this is a
                link and bookmarks, the same reasoning `/sales/targets` already
                uses for its own prev/next. Tomorrow is never offered: nothing
                has reported a position yet that has not happened. */}
            <Link
              href={`/sales/live?day=${addDays(day, -1)}&view=${view}`}
              className="inline-flex h-8 items-center rounded-[4px] border border-line bg-surface px-2.5 text-body no-underline hover:bg-canvas hover:no-underline"
              title="The day before"
            >
              ←
            </Link>
            <span className="px-1 text-[13px] whitespace-nowrap text-muted">
              {isToday ? "Today" : shortDateWithYear(day, now)}
            </span>
            {isToday ? (
              <span
                className="inline-flex h-8 w-8 items-center justify-center text-line"
                aria-hidden
                title="Nothing has been reported for tomorrow yet"
              >
                →
              </span>
            ) : (
              <Link
                href={`/sales/live?day=${addDays(day, 1)}&view=${view}`}
                className="inline-flex h-8 items-center rounded-[4px] border border-line bg-surface px-2.5 text-body no-underline hover:bg-canvas hover:no-underline"
                title="The day after"
              >
                →
              </Link>
            )}
            <Mode
              day={day}
              view={view}
              mine="now"
              label={isToday ? "Where they are now" : "Last position that day"}
            />
            <Mode
              day={day}
              view={view}
              mine="today"
              label={isToday ? "Everywhere they went today" : "Everywhere they went"}
            />
          </div>
        }
      />

      {!tracking ? (
        <Banner
          tone="warn"
          title="Following the route is switched off"
          body="No handset is reporting its position, so the only fixes here are the ones a punch-in and each visit leave behind — a handful a day. Turn it on in the field settings if you want the shape of the day. Either way it runs only between a punch-in and a punch-out."
        />
      ) : noSignal.length ? (
        <Banner
          tone="danger"
          title={
            isToday
              ? `${plural(noSignal.length, "salesman", "salesmen")} with no GPS signal`
              : `${plural(noSignal.length, "salesman", "salesmen")} with no GPS signal that day`
          }
          body="Tracking only runs while they are checked in, so this usually means the day was never started."
        />
      ) : null}

      {view === "today" && noBackgroundTracking.length ? (
        <Banner
          tone="warn"
          title={`${plural(noBackgroundTracking.length, "salesman", "salesmen")} whose trail will have gaps`}
          body="Their phones stop taking fixes the moment the screen locks, or cannot take them at all — gaps no sampling interval or map styling can close. Each row says which of those it is; the fix is theirs to make, in their phone's own Settings, under MahekOne's Location permission."
        />
      ) : null}

      {stalled.length ? (
        <Banner
          tone="danger"
          title={`${plural(stalled.length, "handset")} reporting the tracker stopped`}
          body="Not a guess from missing positions — these phones granted every permission, had the tracking task accepted, and their own watchdog then caught it delivering nothing. The route records only while the app is open until it is fixed, and the fix is on the handset: Sync → Keep tracking on, which walks through the autostart and battery settings the phone is killing it with. Each row says how long it has been stopped."
        />
      ) : null}

      {deadTrail.length ? (
        <Banner
          tone="danger"
          title={`${plural(deadTrail.length, "salesman", "salesmen")} out today with no trail at all`}
          body="Punched in, the handset reporting, and not one position recorded since — which is the tracking service on the phone rather than a signal problem, however long the row underneath says it has been quiet. Their Location permission is usually correct and worth nothing here: these handsets start the service properly and then kill it, so the fix is to allow MahekOne to autostart and set its battery usage to unrestricted, in the phone's own battery settings, then punch out and back in. Each row says how long the man has been out, and names the permission itself only where that is also wrong."
        />
      ) : null}

      {/* Keyed, so a change of day or view remounts the map — and the
          selection sitting above it — rather than asking an effect to
          rebuild either in place. See `live-panel.tsx` and `street-map.tsx`. */}
      <LivePanel
        key={`${day}:${view}`}
        day={day}
        rows={rows}
        tracks={tracks}
        activity={activity}
        gapMetres={config["mbos.location.trailGapMeters"]}
        dwellRadiusMetres={config["mbos.location.dwellRadiusMeters"]}
        dwellMinMinutes={config["mbos.location.dwellMinMinutes"]}
        tripBreakMinutes={config["mbos.location.tripBreakMinutes"]}
        staleAfterSeconds={config["mbos.location.activityFixMaxAgeSeconds"]}
        view={view}
        isToday={isToday}
        olaMapsKey={olaMapsKey}
        handsetThresholds={{
          quietMinutes: config["mbos.location.handsetQuietMinutes"],
          noTrailMinutes: config["mbos.location.noTrailMinutes"],
          lowBatteryPercent: config["mbos.location.lowBatteryPercent"],
          queuedPositionsWorthSaying: config["mbos.location.queuedPositionsWorthSaying"],
          /* Blank is "nobody has said", and `buildIsBehind` answers null to
             that rather than calling every phone current — see its own note. */
          currentAppVersion: config["mbos.sync.currentAppVersion"] || null,
        }}
        nowMs={clockMs}
        /* The point the feed carries on from, on the SERVER's clock — a browser
           a few minutes fast would otherwise ask from an instant that has not
           happened here yet and skip every fix that landed in the gap. */
        cursorMs={clockMs}
        pushSeconds={config["mbos.location.livePushSeconds"]}
        pollSeconds={config["mbos.location.livePollSeconds"]}
      />

      <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
        {tracking
          ? `A handset reports its position about every ${everyWords} while the day is open, and stops at the punch-out. `
          : ""}
        {isToday
          ? out.length
            ? `${plural(out.length, "salesman", "salesmen")} out now. `
            : "Nobody is checked in at the moment. "
          : ""}
        The streets come from Ola Maps; the pins are drawn here from MahekOne&rsquo;s own data,
        so no position is ever sent to it — only which square of map is being looked at.
        {" "}The shops and leads within a few kilometres of each salesman are drawn under
        the day, coloured by what the account is — zoom in for their names, click one for
        its record, or turn them off in the corner of the map. The whole book is on the
        Territory screen.
        {!olaMapsKey ? " No key is set for it yet, so no streets are drawn below." : ""}
        {view === "today" && olaMapsKey
          ? " A dashed stretch of a trail is a real gap — two fixes far enough apart that the road actually taken between them is not known, most often a stretch driven rather than walked, or a dropped signal."
          : ""}
      </p>
    </div>
  );
}

/** One of the two views. A link, not a button — it is a place, and it bookmarks. */
function Mode({
  day,
  view,
  mine,
  label,
}: {
  day: string;
  view: string;
  mine: "now" | "today";
  label: string;
}) {
  const on = view === mine;
  return (
    <Link
      href={`/sales/live?day=${day}&view=${mine}`}
      className={
        "inline-flex h-8 items-center rounded-[4px] border px-3.5 text-[13px] whitespace-nowrap no-underline hover:no-underline " +
        (on
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : "border-line bg-surface text-body hover:bg-canvas")
      }
    >
      {label}
    </Link>
  );
}
