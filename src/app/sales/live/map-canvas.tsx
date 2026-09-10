"use client";

import { APP_TIMEZONE } from "@/lib/business-date";
import { formatDistance } from "@/lib/geo";
import { handsetNotes, type HandsetThresholds, type NoteTone } from "@/lib/handset-health";
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
  selectedId,
  onSelect,
  thresholds,
  nowMs,
}: {
  rows: LastKnown[];
  /** Null outside the "today" view — there is no trail to measure yet. */
  distanceMetres: Map<string, number> | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  thresholds: HandsetThresholds;
  /**
   * Read on the server and passed down — the React Compiler rule this
   * codebase runs under forbids reading the clock during render.
   */
  nowMs: number;
}) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="border-b border-divider px-4 py-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        The team
      </div>
      {rows.map((r) => {
        const hasFix = r.lat != null && r.lng != null;
        const selected = selectedId === r.salesmanId;
        /* An open day is one checked into and not yet out of. It changes what
           silence MEANS — a quiet phone at nine at night is a phone in a
           drawer, not a fault. */
        const notes = handsetNotes(
          { ...r, dayOpen: Boolean(r.checkInAt && !r.checkOutAt) },
          thresholds,
          nowMs,
        );
        return (
          <button
            key={r.salesmanId}
            type="button"
            disabled={!hasFix}
            onClick={() => onSelect(r.salesmanId)}
            title={hasFix ? `Show ${r.salesmanName} on the map` : undefined}
            className={
              "flex w-full items-center gap-2.5 border-t border-[#F7F8FA] px-4 py-3 text-left first:border-t-0 disabled:cursor-default " +
              (hasFix ? "cursor-pointer hover:bg-canvas" : "") +
              (selected ? " bg-brand-soft" : "")
            }
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
              <span className="block text-[12px] text-muted">
                {seenLine(r)}
                {distanceMetres ? ` · ${formatDistance(distanceMetres.get(r.salesmanId) ?? 0)}` : ""}
              </span>
              {r.deviceModel ? (
                <span className="block truncate text-[12px] text-muted" title={deviceTitle(r)}>
                  {r.deviceModel}
                </span>
              ) : null}
              {notes.map((n) => (
                <span
                  key={n.text}
                  className={"mt-0.5 block text-[12px] " + TONE[n.tone]}
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
  );
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
  if (r.place === "Checked in") return "At the day's start point";
  return r.place ?? "On the road";
}

function seenLine(r: LastKnown): string {
  if (!r.seenAt) return "No fix today";
  return `Last seen ${clock(r.seenAt)}`;
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
