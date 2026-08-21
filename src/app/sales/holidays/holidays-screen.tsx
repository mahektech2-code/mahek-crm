"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { addHoliday, removeHoliday } from "@/lib/actions/sales";
import type { HolidayRow } from "@/lib/services/sales-service";
import { SalesIcon } from "../icons";
import { Banner, Button, Cell, Empty, HeadCell, Row, ScreenHeader, Table } from "../parts";

/**
 * The days nobody is expected to work.
 *
 * A small screen that three other things lean on: attendance reads as absent
 * for the whole team otherwise, leave is counted in working days that nothing
 * else defines, and a journey plan will route somebody into a shut market.
 *
 * The scope is typed rather than picked from a list of beats. A holiday is
 * regional in a way the territory model cannot express — "Nagpur East and
 * Nagpur West" is two beats and "all beats" is every beat there will ever be —
 * and a picker built on the beat list would need maintaining every time a beat
 * was renamed. Empty means everywhere.
 */
export function HolidaysScreen({
  holidays,
  todayIso,
}: {
  holidays: HolidayRow[];
  /** The business date, read on the server. */
  todayIso: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [onDate, setOnDate] = React.useState("");
  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await addHoliday({ onDate, name, scope: scope || null });
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOnDate("");
    setName("");
    setScope("");
    toast.push(result.message ?? "Added.");
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(true);
    let result;
    try {
      result = await removeHoliday(id);
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.push(result.message ?? "Removed.");
    router.refresh();
  }

  const ahead = holidays.filter((h) => h.onDate >= todayIso);
  const past = holidays.filter((h) => h.onDate < todayIso);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Holidays"
        subtitle="The days nobody is expected to work. Attendance reads as absent for the whole team without them, leave is measured in working days, and a route planned onto one sends somebody to a shut market."
      />

      {error ? <Banner tone="danger" title="That did not save" body={error} /> : null}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Date
          </span>
          <input
            type="date"
            value={onDate}
            onChange={(e) => setOnDate(e.target.value)}
            className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            What it is
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ganesh Chaturthi"
            className="h-8.5 w-[260px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Where
          </span>
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="Everywhere — or name the beats"
            title="Leave it empty for everybody. A holiday is regional in a way beats cannot express, so this is typed rather than picked."
            className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <Button
          tone="primary"
          disabled={busy || !onDate || !name.trim()}
          title={!onDate || !name.trim() ? "A holiday needs a date and a name." : undefined}
          onClick={() => void add()}
        >
          {busy ? "Saving…" : "Add the day"}
        </Button>
      </div>

      {holidays.length === 0 ? (
        <Empty
          title="No holidays recorded"
          body="Until one is, every day counts as a working day — attendance will read absent for the whole team on a public holiday, and leave will be counted against days nobody was expected in."
        />
      ) : (
        <>
          <Table
            minWidth={840}
            head={
              <>
                <HeadCell width={170}>Date</HeadCell>
                <HeadCell width={140}>Day</HeadCell>
                <HeadCell width={300}>What it is</HeadCell>
                <HeadCell>Where</HeadCell>
                <HeadCell align="right" width={90} />
              </>
            }
          >
            {[...ahead, ...past].map((h, i) => (
              <Row key={h.id} striped={i % 2 === 1}>
                <Cell>
                  <span className={h.onDate < todayIso ? "text-muted" : "text-ink"}>
                    {longDay(h.onDate)}
                  </span>
                </Cell>
                <Cell className="text-muted">{weekday(h.onDate)}</Cell>
                <Cell truncate={300}>{h.name}</Cell>
                <Cell truncate={320}>
                  {h.scope ?? <span className="text-muted">Everywhere</span>}
                </Cell>
                <Cell align="right">
                  <button
                    onClick={() => void remove(h.id)}
                    disabled={busy}
                    aria-label={`Remove ${h.name}`}
                    title="Take this day back off the calendar"
                    className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[3px] text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-40"
                  >
                    <SalesIcon name="close" size={14} />
                  </button>
                </Cell>
              </Row>
            ))}
          </Table>

          <p className="mt-3 text-[13px] text-muted">
            {ahead.length} ahead, {past.length} past.
          </p>
        </>
      )}
    </div>
  );
}

/* Calendar days, built in UTC: there is no time of day in them to get wrong,
   and building them locally is what shifts a date across a DST boundary. */
function parts(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function longDay(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parts(iso));
}

function weekday(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    parts(iso),
  );
}
