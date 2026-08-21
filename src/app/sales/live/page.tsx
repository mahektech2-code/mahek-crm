import Link from "next/link";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import {
  activityPointsForDay,
  lastKnownPositions,
  tracksForDay,
} from "@/lib/services/sales-service";
import { Banner, ScreenHeader } from "../parts";
import { plural } from "../words";
import { MapCanvas, TeamList } from "./map-canvas";

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
 * **The map has no tiles and the design never asked for any.** What it draws is
 * the team's own bounding box, so a pin's place is its place relative to
 * everybody else — see `map-canvas.tsx`.
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

  const [rows, config] = await Promise.all([lastKnownPositions(day), getConfig()]);
  const tracking = config["mbos.location.trackWhileWorking"];
  const everyMinutes = config["mbos.location.trackEveryMinutes"];

  /* Only fetched for the view that draws it. The `now` view needs one row per
     person; the trails are a hundred times that, and paying for them to render
     a screen that does not show them is the sort of cost nobody ever finds. */
  const [tracks, activity] =
    view === "today"
      ? await Promise.all([tracksForDay(day), activityPointsForDay(day)])
      : [new Map(), []];

  const out = rows.filter((r) => r.checkInAt && !r.checkOutAt && !r.onLeave);
  const noSignal = rows.filter((r) => !r.seenAt && !r.onLeave);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Live map"
        subtitle={
          view === "now"
            ? "Where everyone is right now. Tracking runs only while a salesman is checked in, so a missing pin usually means an unstarted day."
            : "Every position each salesman has reported today, in the order it arrived, with the work marked along it. The shape of a day says more than a count of visits does."
        }
        actions={
          <div className="flex flex-none gap-2">
            <Mode day={day} view={view} mine="now" label="Where they are now" />
            <Mode day={day} view={view} mine="today" label="Everywhere they went today" />
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
          title={`${plural(noSignal.length, "salesman", "salesmen")} with no GPS signal`}
          body="Tracking only runs while they are checked in, so this usually means the day was never started."
        />
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_clamp(280px,30%,360px)]">
        <MapCanvas
          rows={rows}
          tracks={tracks}
          activity={activity}
          staleAfterSeconds={config["mbos.location.activityFixMaxAgeSeconds"]}
          view={view}
        />
        <TeamList rows={rows} />
      </div>

      <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
        {tracking
          ? `A handset reports its position about every ${everyMinutes} minutes while the day is open, and stops at the check-out. `
          : ""}
        {out.length
          ? `${plural(out.length, "salesman", "salesmen")} out now. `
          : "Nobody is checked in at the moment. "}
        There is no street map behind the pins: what they show is where everybody is relative to each
        other, which is the question this screen is for — and drawing streets would mean sending
        these coordinates to whoever supplied them.
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
