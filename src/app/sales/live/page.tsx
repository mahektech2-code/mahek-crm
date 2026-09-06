import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { dwellStops, type DwellStop } from "@/lib/engines/dwell";
import { shortDateWithYear } from "@/lib/format";
import { metresBetween } from "@/lib/geo";
import { today } from "@/lib/recompute";
import { readSecret } from "@/lib/secrets";
import {
  activityPointsForDay,
  lastKnownPositions,
  tracksForDay,
} from "@/lib/services/sales-service";
import { Banner, ScreenHeader } from "../parts";
import { plural } from "../words";
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
 * The trail is a fix every few minutes between the check-in and the check-out;
 * the check-in and each visit leave one apiece regardless, so somebody whose
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

  /* "Distance" is the trail's own length, the same honesty rule
     `today-tab.tsx` uses — the sum of the gaps between consecutive fixes,
     never a straight line from start to end. Dwell stops are read off the
     same trail: a run of fixes that never drifted, held long enough to be
     more than a red light. Both are derived here, once, rather than inside
     the client map component, which redraws on every selection change. */
  const distanceMetres = new Map<string, number>();
  const dwells = new Map<string, DwellStop[]>();
  for (const [id, points] of tracks) {
    let metres = 0;
    for (let i = 1; i < points.length; i++) {
      metres += metresBetween(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    }
    distanceMetres.set(id, metres);
    dwells.set(
      id,
      dwellStops(points, config["mbos.location.dwellRadiusMeters"], config["mbos.location.dwellMinMinutes"]),
    );
  }

  const out = rows.filter((r) => r.checkInAt && !r.checkOutAt && !r.onLeave);
  const noSignal = rows.filter((r) => !r.seenAt && !r.onLeave);
  /* False, never null — null means the app has not reported yet, which is
     not the same claim as "refused". See `mbos_devices.background_location_
     granted`'s own comment for what the difference actually costs a trail. */
  const noBackgroundTracking = rows.filter((r) => r.backgroundTrackingGranted === false && !r.onLeave);

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
          body="No handset is reporting its position, so the only fixes here are the ones a check-in and each visit leave behind — a handful a day. Turn it on in the field settings if you want the shape of the day. Either way it runs only between a check-in and a check-out."
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
          title={`${plural(noBackgroundTracking.length, "salesman", "salesmen")} without background location`}
          body="Their trail will have real gaps that no sampling interval or map styling can close — the phone stops taking fixes the moment its screen locks. Ask them to open their phone's own Settings and set MahekOne's Location permission to “Allow all the time”."
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
        distanceMetres={distanceMetres}
        dwells={dwells}
        gapMetres={config["mbos.location.trailGapMeters"]}
        staleAfterSeconds={config["mbos.location.activityFixMaxAgeSeconds"]}
        view={view}
        isToday={isToday}
        olaMapsKey={olaMapsKey}
      />

      <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
        {tracking
          ? `A handset reports its position about every ${everyWords} while the day is open, and stops at the check-out. `
          : ""}
        {isToday
          ? out.length
            ? `${plural(out.length, "salesman", "salesmen")} out now. `
            : "Nobody is checked in at the moment. "
          : ""}
        The streets come from Ola Maps; the pins are drawn here from MahekOne&rsquo;s own data,
        so no position is ever sent to it — only which square of map is being looked at.
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
