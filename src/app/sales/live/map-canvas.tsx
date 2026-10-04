"use client";

import * as React from "react";
import { APP_TIMEZONE } from "@/lib/business-date";
import { formatDistance } from "@/lib/geo";
import {
  ageWords,
  handsetNotes,
  type HandsetThresholds,
  type NoteTone,
} from "@/lib/handset-health";
import type { LastKnown } from "@/lib/services/sales-service";

/**
 * The team, beside the map.
 *
 * Everybody, including whoever has no pin — a salesman missing from both the
 * map and the list is a salesman nobody notices is missing, which is the
 * opposite of what this screen is for. The dot repeats what the pin colour
 * says, because the row is read on its own as often as beside the map.
 *
 * **A row is a SELECT, not a link, when there is somewhere to point at.**
 * Clicking a name used to navigate straight to their profile; what a manager
 * actually reaches for here is "where is he", and that answer is the map two
 * feet away, not a different page. Clicking the same name again — or picking
 * somebody else — gives the map back to the whole team. Whoever has no fix
 * has nothing for the map to point at, so their row stays informational
 * rather than pretending a click would do something.
 *
 * **AND IT SAYS WHY THERE IS NO PIN, where the handset was able to tell us.**
 * "No fix today" covers a refused permission, location switched off on the
 * phone, no signal since breakfast and a flat battery — four different
 * conversations, and a manager who cannot tell them apart rings the salesman
 * to ask him to read out his own settings screen. `handsetNotes` is the one
 * place those become words; the thresholds are configuration and arrive as a
 * prop, because this is a client component and has no async config of its own.
 *
 * **Nothing is drawn for a healthy phone.** A row listing four green facts is
 * a specification sheet, and the line that matters gets read as furniture.
 */
export function TeamList({
  rows,
  distanceMetres,
  speedKmh,
  selectedId,
  onSelect,
  thresholds,
  nowMs,
  isToday,
  feed,
}: {
  rows: LastKnown[];
  /** Null outside the "today" view — there is no trail to measure yet. */
  distanceMetres: Map<string, number> | null;
  /** Only the people moving faster than the configured floor are in it. */
  speedKmh?: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  thresholds: HandsetThresholds;
  /**
   * Read on the server and passed down — the React Compiler rule this
   * codebase runs under forbids reading the clock during render.
   */
  nowMs: number;
  /**
   * Whether the day on screen is TODAY — which decides whether an age beside
   * a fix means anything. See `seenLine`, and the warnings on the page above,
   * which are gated on it for the same reason.
   */
  isToday: boolean;
  /** Whether the feed is live, drawn in the rail's header. */
  feed?: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");

  /* Every row's notes and status, worked out once per render rather than once
     per filter chip — the chips count what the list would show. */
  const items = rows.map((r) => {
    /* An open day is one checked into and not yet out of. It changes what
       silence MEANS — a quiet phone at nine at night is a phone in a
       drawer, not a fault.

       `hasFix` is deliberately NOT what answers "has his trail produced
       anything": it is true of a salesman whose only fix all day is his own
       punch-in, which is exactly the handset whose tracking is dead.
       `trailSeenAt` comes down the row for that question and nothing else —
       see `handset-health`'s `trailIsDead`. */
    const notes = handsetNotes({ ...r, dayOpen: Boolean(r.checkInAt && !r.checkOutAt) }, thresholds, nowMs);
    return { r, notes, status: statusOf(r), attention: notes.some((n) => n.tone !== "info") };
  });

  const counts: Record<Filter, number> = {
    all: items.length,
    out: items.filter((i) => i.status === "out").length,
    attention: items.filter((i) => i.attention).length,
    notIn: items.filter((i) => i.status === "notIn").length,
    done: items.filter((i) => i.status === "done").length,
    leave: items.filter((i) => i.status === "leave").length,
  };

  const q = query.trim().toLowerCase();
  const shown = items.filter(
    (i) =>
      (filter === "all" || (filter === "attention" ? i.attention : i.status === filter)) &&
      (!q ||
        i.r.salesmanName.toLowerCase().includes(q) ||
        (i.r.place ?? "").toLowerCase().includes(q) ||
        (i.r.deviceModel ?? "").toLowerCase().includes(q)),
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="flex-none border-b border-divider px-3 pt-3 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            The team <span className="tabular-nums">· {rows.length}</span>
          </span>
          {feed}
        </div>
        {rows.length > 6 ? (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a salesman, a place or a phone"
            className="mt-2 h-8 w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted focus:border-brand focus:outline-none"
          />
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1">
          {FILTERS.filter((f) => f.key === "all" || counts[f.key] > 0 || filter === f.key).map((f) => {
            const on = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(on && f.key !== "all" ? "all" : f.key)}
                className={
                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] whitespace-nowrap " +
                  (on
                    ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                    : "border-line bg-surface text-body hover:bg-canvas")
                }
              >
                {f.label}
                <span className="tabular-nums opacity-70">{counts[f.key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">
            {rows.length === 0 ? "Nobody on the team yet." : "Nobody matches that."}
          </p>
        ) : null}
        {shown.map(({ r, notes }) => {
          const hasFix = r.lat != null && r.lng != null;
          const selected = selectedId === r.salesmanId;
          const distance = distanceMetres ? distanceMetres.get(r.salesmanId) ?? 0 : null;
          const speed = r.checkOutAt ? undefined : speedKmh?.get(r.salesmanId);
          return (
            <button
              key={r.salesmanId}
              type="button"
              disabled={!hasFix}
              onClick={() => onSelect(r.salesmanId)}
              title={hasFix ? `Show ${r.salesmanName} on the map` : "No position to show on the map"}
              aria-pressed={selected}
              className={
                "flex w-full items-start gap-2.5 border-t border-divider px-3 py-2.5 text-left first:border-t-0 disabled:cursor-default " +
                (hasFix ? "cursor-pointer hover:bg-canvas" : "") +
                (selected ? " bg-brand-soft shadow-[inset_3px_0_0_#6E3FF3]" : "")
              }
            >
              <span className="relative mt-0.5 flex size-7 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                {r.initials}
                <span
                  className="absolute -right-0.5 -bottom-0.5 block size-2.5 rounded-full border-2 border-surface"
                  style={{ background: dotColour(r) }}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{r.salesmanName}</span>
                  {speed != null ? (
                    <span
                      className="ml-auto flex-none text-[12px] font-medium text-ink tabular-nums"
                      title="How fast he has moved over his last minute of positions"
                    >
                      {speed} km/h
                    </span>
                  ) : null}
                  {distance != null ? (
                    <span className="flex-none text-[12px] text-muted tabular-nums">
                      {formatDistance(distance)}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-muted">
                  {whereLine(r)} · {seenLine(r, nowMs, isToday, thresholds.noTrailMinutes)}
                </span>
                {r.deviceModel ? (
                  <span className="block truncate text-[11px] text-muted" title={deviceTitle(r)}>
                    {r.deviceModel}
                  </span>
                ) : null}
                {notes.map((n) => (
                  <span
                    key={n.text}
                    className={"mt-0.5 block text-[12px] leading-[16px] " + TONE[n.tone]}
                    title={n.detail}
                  >
                    {n.text}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the filters */

type Status = "out" | "done" | "notIn" | "leave";
type Filter = "all" | "attention" | Status;

/**
 * THE LIST IS FILTERED, NEVER THE MAP. At six salesmen a list is read top to
 * bottom; at sixty it is searched, and the first question is "who needs me"
 * — so "Needs attention" is a chip of its own, reading the same notes the rows
 * draw. The map keeps everybody, because a filter that hid pins would make a
 * missing salesman look like one who was never there.
 */
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "out", label: "Out" },
  { key: "notIn", label: "Not checked in" },
  { key: "done", label: "Punched out" },
  { key: "leave", label: "On leave" },
];

function statusOf(r: LastKnown): Status {
  if (r.onLeave) return "leave";
  if (!r.checkInAt) return "notIn";
  return r.checkOutAt ? "done" : "out";
}

/* --------------------------------------------------------------- the words */

/**
 * Three tones, and the middle one is doing the real work.
 *
 * `bad` is a handset that cannot report at all, `warn` is one reporting with
 * holes in it, `info` is context rather than a problem. A battery that is
 * merely low reads `warn`; the same battery on charge reads `info`, because
 * there is nothing to do about it.
 */
const TONE: Record<NoteTone, string> = {
  bad: "text-[#B3261E]",
  warn: "text-[#8A5A00]",
  info: "text-muted",
};

/**
 * The build, on hover rather than on the row.
 *
 * Which APK somebody is on matters exactly twice — when a feature is missing
 * and when a bug is being chased — and on every other day it is noise on a
 * panel that has to be scanned. The model itself stays visible, because that
 * is what a manager says out loud when he rings the salesman.
 */
function deviceTitle(r: LastKnown): string {
  return r.appVersion ? `${r.deviceModel} · MBOS ${r.appVersion}` : (r.deviceModel ?? "");
}

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
  if (r.place === "Punched in") return "At the day's start point";
  return r.place ?? "On the road";
}

/**
 * AND HOW OLD THAT IS, because a clock time is not an age.
 *
 * "Last seen 16:12" is read at a glance as a recent fact, and the glance is
 * what this row is for — a manager scanning eight of them does not subtract
 * 16:12 from the wall clock, he reads a time and moves on. On a phone whose
 * trail stopped at four, that is the whole of what the screen told him, and
 * it is what was reported as the map being broken: the handset was in
 * constant contact and every reading in those batches was hours old.
 *
 * IT IS THE TIME OF THE FIX AND NEVER THE TIME IT ARRIVED — see `seenAt` on
 * the service, which says so deliberately and is right to. Nothing here
 * changes that; what it adds is the age, so the two cannot be confused by
 * somebody reading quickly.
 *
 * SAID ONLY WHERE IT MEANS SOMETHING, like every other line on this panel. A
 * fresh fix needs no age beside it, and a day in March measured against this
 * afternoon's clock is an arithmetic that says nothing about that Tuesday —
 * which is why the banners upstairs are gated on `isToday` for exactly this
 * reason. The threshold is the office's own `noTrailMinutes`, so the age
 * appears on precisely the rows that have a note explaining it.
 */
function seenLine(
  r: LastKnown,
  nowMs: number,
  isToday: boolean,
  noTrailMinutes: number,
): string {
  if (!r.seenAt) return "No fix today";
  const at = new Date(r.seenAt).getTime();
  const stale = isToday && Number.isFinite(at) && nowMs - at > noTrailMinutes * 60_000;
  return `Last seen ${clock(r.seenAt)}${stale ? ` · ${ageWords(at, nowMs)} ago` : ""}`;
}

function dotColour(r: LastKnown): string {
  if (r.onLeave) return "#C2C8D2";
  return r.checkInAt && !r.checkOutAt ? "#1D7A45" : "#B3261E";
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
