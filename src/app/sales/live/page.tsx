import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { dropInaccurateFixes } from "@/lib/engines/trail-gaps";
import { nowMs, shortDateWithYear } from "@/lib/format";
import { trackerStalled, trailHasGaps, trailHasStopped, trailIsDead } from "@/lib/handset-health";
import { today } from "@/lib/recompute";
import { liveOlaKey } from "@/lib/services/ola-key-service";
import {
  activityPointsForDay,
  lastKnownPositions,
  tracksForDay,
  visitsBetween,
} from "@/lib/services/sales-service";
import { plural } from "@/components/console/words";
import { LiveAlerts, type LiveAlert } from "./live-alerts";
import { LivePanel } from "./live-panel";
import { VisitsStrip } from "./visits-strip";

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
  searchParams: Promise<{ day?: string; view?: string; salesman?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;
  /* A link from Today names one salesman, and what it asks is "show me his
     day" — so his trail, not only his last pin, unless a view was named. */
  const focusParam = params.salesman ?? null;
  const view = params.view === "now" ? "now" : params.view === "today" || focusParam ? "today" : "now";
  const isToday = day === now;

  const [rows, config, olaMaps] = await Promise.all([
    lastKnownPositions(day),
    getConfig(),
    liveOlaKey(),
  ]);
  /* WHICH key, and whether the reason there is none is that every one held has
     run out, are answered together — a browser cannot fail over mid-session,
     so what it gets is the live key at RENDER and, where there is none left, a
     sentence saying which of the two silences this is. */
  const olaMapsKey = olaMaps.key;
  /* Only somebody on this manager's own team — `lastKnownPositions` is already
     scoped, so an id from outside it simply focuses nobody. */
  const focus = focusParam ? (rows.find((r) => r.salesmanId === focusParam) ?? null) : null;
  const focusVisits = focus
    ? await visitsBetween({ from: day, to: day, salesmanId: focus.salesmanId })
    : [];
  const keep = focus ? `&salesman=${focus.salesmanId}` : "";
  const olaKeysSpent = olaMaps.allSpent;
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

  /* A TRAIL THAT RAN AND STOPPED, which `deadTrail` above cannot count: that
     one answers false the moment there is any position at all, so a route
     that ended at four in the afternoon fell between every banner on this
     screen and every note on its own row. It is the commonest shape of a lost
     day and it was the one with nothing said about it — and worse, the
     handset behind it is usually in perfect contact with us, flushing a
     backlog, which reads on every other column as a phone working properly.
     Mutually exclusive with `deadTrail` by construction, so no handset is
     counted in both. Today only, for the reason the two above are. */
  const stoppedTrail = isToday
    ? rows.filter(
        (r) =>
          !r.onLeave &&
          trailHasStopped(
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

  const notIn = rows.filter((r) => !r.onLeave && !r.checkInAt).length;
  const finished = rows.filter((r) => !r.onLeave && r.checkOutAt).length;
  const onLeave = rows.filter((r) => r.onLeave).length;

  /* Every warning the screen has to give, as data — `LiveAlerts` draws them
     as one row of chips with the explanation a click away, so the map keeps
     the screen however bad the morning is. The wording is unchanged. */
  const alerts: LiveAlert[] = [];
  if (!tracking) {
    alerts.push({
      key: "off",
      tone: "warn",
      title: "Following the route is switched off",
      body: "No handset is reporting its position, so the only fixes here are the ones a punch-in and each visit leave behind — a handful a day. Turn it on in the field settings if you want the shape of the day. Either way it runs only between a punch-in and a punch-out.",
    });
  } else if (noSignal.length) {
    alerts.push({
      key: "no-signal",
      tone: "danger",
      title: isToday
        ? `${plural(noSignal.length, "salesman", "salesmen")} with no GPS signal`
        : `${plural(noSignal.length, "salesman", "salesmen")} with no GPS signal that day`,
      body: "Tracking only runs while they are checked in, so this usually means the day was never started.",
    });
  }
  if (stalled.length) {
    alerts.push({
      key: "stalled",
      tone: "danger",
      title: `${plural(stalled.length, "handset")} reporting the tracker stopped`,
      body: "Not a guess from missing positions — these phones granted every permission, had the tracking task accepted, and their own watchdog then caught it delivering nothing. The route records only while the app is open until it is fixed, and the fix is on the handset: Sync → Keep tracking on, which walks through the autostart and battery settings the phone is killing it with. Each row says how long it has been stopped.",
    });
  }
  if (deadTrail.length) {
    alerts.push({
      key: "dead",
      tone: "danger",
      title: `${plural(deadTrail.length, "salesman", "salesmen")} out today with no trail at all`,
      body: "Punched in, the handset reporting, and not one position recorded since — which is the tracking service on the phone rather than a signal problem, however long the row underneath says it has been quiet. Their Location permission is usually correct and worth nothing here: these handsets start the service properly and then kill it, so the fix is to allow MahekOne to autostart and set its battery usage to unrestricted, in the phone's own battery settings, then punch out and back in. Each row says how long the man has been out, and names the permission itself only where that is also wrong.",
    });
  }
  if (stoppedTrail.length) {
    alerts.push({
      key: "stopped",
      tone: "warn",
      title: `${plural(stoppedTrail.length, "salesman", "salesmen")} whose route has stopped reaching us`,
      body: "They are out, they were being tracked, and their positions have stopped arriving — so the map is showing where each of them was rather than where he is, and the time on the row is the time of that fix and not of the last contact. That distinction is the whole of this warning: a handset catching up a backlog talks to us constantly while every reading it sends is hours old, which reads on every other column as a phone working perfectly. Each row says how long it has been, and whether the phone is holding the missing part — if it is, the work is safe and merely late.",
    });
  }
  if (view === "today" && noBackgroundTracking.length) {
    alerts.push({
      key: "gaps",
      tone: "warn",
      title: `${plural(noBackgroundTracking.length, "salesman", "salesmen")} whose trail will have gaps`,
      body: "Their phones stop taking fixes the moment the screen locks, or cannot take them at all — gaps no sampling interval or map styling can close. Each row says which of those it is; the fix is theirs to make, in their phone's own Settings, under MahekOne's Location permission.",
    });
  }

  const subtitle = isToday
    ? view === "now"
      ? "Where everyone is right now. Tracking runs only while a salesman is checked in, so a missing pin usually means an unstarted day."
      : "Every position each salesman has reported today, in the order it arrived, with the work marked along it. The shape of a day says more than a count of visits does."
    : view === "now"
      ? `Each salesman's last reported position on ${shortDateWithYear(day, now)}. A missing pin means no fix was ever recorded that day.`
      : `Every position each salesman reported on ${shortDateWithYear(day, now)}, in the order it arrived, with the work marked along it.`;

  /* THE PAGE IS THE HEIGHT OF THE WINDOW, and the map takes what is left.
     The Sales Dashboard frame bleeds, so this is the whole of `main`: a short
     toolbar, one line of warnings, and the map with the team beside it filling
     the rest. It used to be a header, up to five paragraph-long banners and a
     footnote stacked around a map of fixed height, which at any real team size
     put the map below the fold. Below `min-h` the page scrolls rather than
     crushing the map into a strip. */
  return (
    <div className="flex h-full min-h-[640px] flex-col gap-3 px-5 pt-4 pb-4">
      <div className="flex flex-none flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl leading-[30px] font-semibold text-ink">
            {focus ? focus.salesmanName : "Live map"}
          </h1>
          {focus ? (
            <Link href={`/sales/live?day=${day}&view=${view}`} className="text-[13px] whitespace-nowrap">
              Whole team
            </Link>
          ) : null}
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-muted">
            <Count n={rows.length} label={plural(rows.length, "salesman", "salesmen")} plain />
            {isToday ? <Count n={out.length} label="out now" tone="good" /> : null}
            {finished ? <Count n={finished} label="punched out" /> : null}
            {notIn ? <Count n={notIn} label={isToday ? "not checked in" : "never checked in"} tone="bad" /> : null}
            {onLeave ? <Count n={onLeave} label="on leave" /> : null}
          </p>
        </div>

        <div className="flex flex-none items-center gap-2">
          {/* A day, not a month — see the comment on `Mode` for why this is a
              link and bookmarks, the same reasoning `/sales/targets` already
              uses for its own prev/next. Tomorrow is never offered: nothing
              has reported a position yet that has not happened. */}
          <div className="inline-flex h-8 items-stretch overflow-hidden rounded-[4px] border border-line bg-surface">
            <Link
              href={`/sales/live?day=${addDays(day, -1)}&view=${view}${keep}`}
              className="inline-flex w-8 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline"
              title="The day before"
            >
              ←
            </Link>
            <span className="inline-flex min-w-[92px] items-center justify-center border-x border-line px-2 text-[13px] whitespace-nowrap text-ink">
              {isToday ? "Today" : shortDateWithYear(day, now)}
            </span>
            {isToday ? (
              <span
                className="inline-flex w-8 items-center justify-center text-line"
                aria-hidden
                title="Nothing has been reported for tomorrow yet"
              >
                →
              </span>
            ) : (
              <Link
                href={`/sales/live?day=${addDays(day, 1)}&view=${view}${keep}`}
                className="inline-flex w-8 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline"
                title="The day after"
              >
                →
              </Link>
            )}
          </div>
          {!isToday ? (
            <Link
              href={`/sales/live?view=${view}${keep}`}
              className="inline-flex h-8 items-center rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
            >
              Back to today
            </Link>
          ) : null}
          <div className="inline-flex h-8 items-stretch rounded-[4px] border border-line bg-surface p-0.5">
            <Mode day={day} view={view} keep={keep} mine="now" label={isToday ? "Where they are now" : "Last position"} />
            <Mode
              day={day}
              view={view}
              keep={keep}
              mine="today"
              label={isToday ? "Everywhere they went today" : "Everywhere they went"}
            />
          </div>
          <About>
            <p>{subtitle}</p>
            <p className="mt-2">
              {tracking
                ? `A handset reports its position about every ${everyWords} while the day is open, and stops at the punch-out. `
                : ""}
              The streets come from Ola Maps; the pins are drawn here from MahekOne&rsquo;s own data,
              so no position is ever sent to it — only which square of map is being looked at.
            </p>
            <p className="mt-2">
              The shops and leads within a few kilometres of each salesman are drawn under the day,
              coloured by what the account is — zoom in for their names, click one for its record, or
              turn them off in the corner of the map. The whole book is on the Territory screen.
            </p>
            {!olaMapsKey ? (
              <p className="mt-2">
                {olaKeysSpent
                  ? "Every Ola Maps key held has reached its quota, so no streets are drawn until one resets or another is added."
                  : "No key is set for it yet, so no streets are drawn."}
              </p>
            ) : null}
            {view === "today" && olaMapsKey ? (
              <p className="mt-2">
                A dashed stretch of a trail is a real gap — two fixes far enough apart that the road
                actually taken between them is not known, most often a stretch driven rather than
                walked, or a dropped signal.
              </p>
            ) : null}
          </About>
        </div>
      </div>

      <LiveAlerts alerts={alerts} />

      {/* Keyed, so a change of day or view remounts the map — and the
          selection sitting above it — rather than asking an effect to
          rebuild either in place. See `live-panel.tsx` and `street-map.tsx`. */}
      <div className="min-h-0 flex-1">
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
          speedMinKmh={config["mbos.location.liveSpeedMinKmh"]}
          accuracyThresholdM={accuracyThreshold}
          view={view}
          isToday={isToday}
          olaMapsKey={olaMapsKey}
          olaKeysSpent={olaKeysSpent}
          initialSelectedId={focus?.salesmanId ?? null}
          handsetThresholds={{
            quietMinutes: config["mbos.location.handsetQuietMinutes"],
            noTrailMinutes: config["mbos.location.noTrailMinutes"],
            lowBatteryPercent: config["mbos.location.lowBatteryPercent"],
            queuedPositionsWorthSaying: config["mbos.location.queuedPositionsWorthSaying"],
            /* NOT A THRESHOLD OF ITS OWN. `uploaderSilenceMs` reads the office's
               own quiet window and uses this only as a floor under it — and as
               the switch that turns the note off entirely where the recorder
               does no posting, which is what zero here means. */
            serviceUploadEverySeconds: config["mbos.location.serviceUploadEverySeconds"],
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
      </div>

      {focus ? <VisitsStrip visits={focusVisits} isToday={isToday} /> : null}
    </div>
  );
}

/** One figure in the summary line beside the title. */
function Count({
  n,
  label,
  tone,
  plain = false,
}: {
  n: number;
  label: string;
  tone?: "good" | "bad";
  plain?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {plain ? null : (
        <span
          className="block size-1.5 flex-none rounded-full"
          style={{ background: tone === "good" ? "#1D7A45" : tone === "bad" ? "#B3261E" : "#C2C8D2" }}
        />
      )}
      <span className="font-semibold text-ink tabular-nums">{n}</span>
      {label}
    </span>
  );
}

/**
 * What the screen is, and where its streets come from — read once, so it sits
 * behind a button instead of under the map where it pushed the map up.
 */
function About({ children }: { children: React.ReactNode }) {
  return (
    <details className="group relative">
      <summary
        className="inline-flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] font-semibold text-muted hover:bg-canvas [&::-webkit-details-marker]:hidden"
        title="About this map"
        aria-label="About this map"
      >
        ?
      </summary>
      <div className="absolute top-10 right-0 z-30 w-[380px] rounded-[6px] border border-line bg-surface p-4 text-[13px] text-pretty text-body shadow-[0_4px_16px_rgba(22,22,22,0.15)]">
        {children}
      </div>
    </details>
  );
}

/** One of the two views. A link, not a button — it is a place, and it bookmarks. */
function Mode({
  day,
  view,
  keep,
  mine,
  label,
}: {
  day: string;
  view: string;
  keep: string;
  mine: "now" | "today";
  label: string;
}) {
  const on = view === mine;
  return (
    <Link
      href={`/sales/live?day=${day}&view=${mine}${keep}`}
      aria-current={on ? "page" : undefined}
      className={
        "inline-flex items-center rounded-[3px] px-3 text-[13px] whitespace-nowrap no-underline hover:no-underline " +
        (on ? "bg-brand-soft font-medium text-[#5223E0]" : "text-body hover:bg-canvas")
      }
    >
      {label}
    </Link>
  );
}
