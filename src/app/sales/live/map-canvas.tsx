"use client";

import { APP_TIMEZONE } from "@/lib/business-date";
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
 */
export function TeamList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: LastKnown[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="border-b border-divider px-4 py-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        The team
      </div>
      {rows.map((r) => {
        const hasFix = r.lat != null && r.lng != null;
        const selected = selectedId === r.salesmanId;
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
              <span className="block text-[12px] text-muted">{seenLine(r)}</span>
            </span>
          </button>
        );
      })}
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
