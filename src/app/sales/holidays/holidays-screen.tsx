"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/overlays";
import { cx } from "@/components/ui/primitives";
import { calendarDate } from "@/lib/business-date";
import { removeHoliday, setHolidayPerson } from "@/lib/actions/sales";
import { HOLIDAY_LEVELS, HOLIDAY_LEVEL_LABEL, type HolidayLevel } from "@/lib/engines/holiday-audience";
import type { HolidayCalendar, HolidayEntry, HolidayPersonRow } from "@/lib/services/holiday-service";
import { Banner, Button, Cell, Empty, HeadCell, MetricRow, Pill, Row, RowMenu, ScreenHeader, Table } from "@/components/console/parts";
import { HolidayEditor } from "./holiday-editor";

export type HolidaysView = "calendar" | "levels" | "people";

/**
 * THE HOLIDAY CALENDAR, three ways.
 *
 * - CALENDAR: every day of the year, who it is for, and how many of the team
 *   it reaches — open a row to see exactly who and why.
 * - BY LEVEL: company-wide, then each state, district, city and area with the
 *   people who work there and the days that are theirs, then the named ones.
 * - BY EMPLOYEE: each salesman's year — how many days he gets and which —
 *   and the switch that gives one to him or takes one away.
 *
 * Who a day reaches is the server's answer (`holiday-audience.ts`, the same
 * engine the handset's `universal` and the attendance verdict are written
 * from), never worked out again here.
 */
export function HolidaysScreen({
  calendar,
  todayIso,
  view,
  person,
}: {
  calendar: HolidayCalendar;
  /** The business date, read on the server. */
  todayIso: string;
  view: HolidaysView;
  person: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const { year, holidays, people } = calendar;

  const [editing, setEditing] = React.useState<HolidayEntry | "new" | null>(null);
  const [removing, setRemoving] = React.useState<HolidayEntry | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const href = (over: { year?: number; view?: HolidaysView; person?: string | null }) => {
    const p = new URLSearchParams();
    p.set("year", String(over.year ?? year));
    const v = over.view ?? view;
    if (v !== "calendar") p.set("view", v);
    const who = over.person === undefined ? person : over.person;
    if (who) p.set("person", who);
    return `/sales/holidays?${p.toString()}`;
  };

  const ahead = holidays.filter((h) => h.onDate >= todayIso);
  const levelCount = (l: HolidayLevel) => holidays.filter((h) => h.level === l).length;
  const regional = levelCount("state") + levelCount("district") + levelCount("city") + levelCount("area");
  const legacy = holidays.filter((h) => h.typedScope);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Holidays"
        subtitle="Company-wide, state, district, city and area holidays, and days given to named people. Who gets a day decides whether it reads as absent, what leave costs, and what the salesman's phone shows — a change here reaches the handsets on their next sync."
        actions={
          <>
            <div className="flex items-center gap-1 rounded-[4px] border border-line bg-surface">
              <Link href={href({ year: year - 1 })} aria-label="Previous year" className="px-2 py-1.5 text-muted hover:text-ink">
                ‹
              </Link>
              <span className="px-1 text-sm font-semibold text-ink tabular-nums">{year}</span>
              <Link href={href({ year: year + 1 })} aria-label="Next year" className="px-2 py-1.5 text-muted hover:text-ink">
                ›
              </Link>
            </div>
            <Button tone="primary" onClick={() => setEditing("new")}>
              Add a holiday
            </Button>
          </>
        }
      />

      {error ? <Banner tone="danger" title="That did not save" body={error} /> : null}
      {legacy.length ? (
        <Banner
          tone="warn"
          title={`${legacy.length} ${legacy.length === 1 ? "holiday was" : "holidays were"} typed before levels existed`}
          body={`${legacy.map((h) => `${h.name} (“${h.typedScope}”)`).join(", ")} — read as company-wide until somebody edits ${legacy.length === 1 ? "it" : "them"} and picks who ${legacy.length === 1 ? "it is" : "they are"} for.`}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: `Holidays in ${year}`, value: String(holidays.length), sub: `${ahead.length} still ahead` },
          { label: "Company-wide", value: String(levelCount("company")) },
          { label: "State & regional", value: String(regional), sub: "state · district · city · area" },
          { label: "Named people", value: String(levelCount("people")) },
          { label: "Team", value: String(people.length), sub: "people in the field" },
        ]}
      />

      <div className="mb-4 flex gap-1 border-b border-line">
        {(
          [
            ["calendar", "Calendar"],
            ["levels", "By level"],
            ["people", "By employee"],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            href={href({ view: key, person: key === "people" ? person : null })}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              view === key ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {label}
          </Link>
        ))}
      </div>

      {view === "calendar" ? (
        <CalendarView holidays={holidays} people={people} todayIso={todayIso} onEdit={setEditing} onRemove={setRemoving} />
      ) : view === "levels" ? (
        <LevelsView calendar={calendar} todayIso={todayIso} onEdit={setEditing} />
      ) : (
        <PeopleView calendar={calendar} todayIso={todayIso} person={person} personHref={(id) => href({ person: id })} onError={setError} />
      )}

      <HolidayEditor
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        open={editing !== null}
        editing={editing === "new" ? null : editing}
        defaultDate={todayIso.slice(0, 4) === String(year) ? todayIso : `${year}-01-01`}
        people={people}
        states={calendar.states}
        onClose={() => setEditing(null)}
        onSaved={(message) => {
          setEditing(null);
          setError(null);
          toast.push(message);
          router.refresh();
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name}?` : ""}
        body={
          removing
            ? `${longDay(removing.onDate)} stops being a holiday for the ${removing.members.length} ${removing.members.length === 1 ? "person" : "people"} it reaches, on the office's screens and on their phones at the next sync. HRMS's copy goes too.`
            : ""
        }
        confirmLabel="Remove the holiday"
        destructive
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const r = await removeHoliday(removing.id);
          setRemoving(null);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          toast.push(r.message ?? "Removed.");
          router.refresh();
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ the calendar */

const LEVEL_TONE: Record<HolidayLevel, "brand" | "success" | "warn" | "neutral" | "danger"> = {
  company: "brand",
  state: "success",
  district: "success",
  city: "warn",
  area: "warn",
  people: "neutral",
};

function LevelPill({ level }: { level: HolidayLevel }) {
  return <Pill tone={LEVEL_TONE[level]}>{HOLIDAY_LEVEL_LABEL[level]}</Pill>;
}

function CalendarView({
  holidays,
  people,
  todayIso,
  onEdit,
  onRemove,
}: {
  holidays: HolidayEntry[];
  people: HolidayPersonRow[];
  todayIso: string;
  onEdit: (h: HolidayEntry) => void;
  onRemove: (h: HolidayEntry) => void;
}) {
  const [filter, setFilter] = React.useState<HolidayLevel | "all">("all");
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const names = new Map(people.map((p) => [p.id, p.name]));

  const q = query.trim().toLowerCase();
  const shown = holidays.filter(
    (h) =>
      (filter === "all" || h.level === filter) &&
      (!q || `${h.name} ${h.category} ${h.audienceLabel ?? ""} ${h.places.map((p) => p.label).join(" ")}`.toLowerCase().includes(q)),
  );

  if (!holidays.length)
    return (
      <Empty
        title="No holidays recorded for this year"
        body="Until one is, every day counts as a working day — attendance reads absent on a public holiday, and leave is counted against days nobody was expected in."
      />
    );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(["all", ...HOLIDAY_LEVELS] as const).map((l) => {
          const count = l === "all" ? holidays.length : holidays.filter((h) => h.level === l).length;
          return (
            <button
              key={l}
              type="button"
              onClick={() => setFilter(l)}
              className={cx(
                "h-7 cursor-pointer rounded-[14px] border px-3 text-[13px]",
                filter === l ? "border-brand bg-brand-soft font-medium text-[#5223E0]" : "border-line bg-surface text-body",
              )}
            >
              {l === "all" ? "All" : HOLIDAY_LEVEL_LABEL[l]} <span className="text-muted tabular-nums">{count}</span>
            </button>
          );
        })}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a holiday or a place"
          className="ml-auto h-8 w-[240px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
        />
      </div>

      {shown.length === 0 ? (
        <Empty title="Nothing matches" body="No holiday this year matches that filter." />
      ) : (
        <Table
          minWidth={1080}
          head={
            <>
              <HeadCell width={190}>Date</HeadCell>
              <HeadCell width={110}>Day</HeadCell>
              <HeadCell width={260}>Holiday</HeadCell>
              <HeadCell>Who it is for</HeadCell>
              <HeadCell width={150}>Reaches</HeadCell>
              <HeadCell align="right" width={70} />
            </>
          }
        >
          {shown.map((h, i) => {
            const past = h.onDate < todayIso;
            const expanded = open === h.id;
            return (
              <React.Fragment key={h.id}>
                <Row striped={i % 2 === 1} selected={expanded}>
                  <Cell>
                    <span className={past ? "text-muted" : "font-medium text-ink"}>{longDay(h.onDate)}</span>
                  </Cell>
                  <Cell className="text-muted">{weekday(h.onDate)}</Cell>
                  <Cell truncate={260} title={h.note ?? undefined}>
                    {h.name} <span className="text-[12px] text-muted">· {h.category}</span>
                  </Cell>
                  <Cell>
                    <span className="flex items-center gap-2">
                      <LevelPill level={h.level} />
                      <span className="truncate text-[13px] text-body">
                        {h.level === "company" ? "Everybody" : (h.audienceLabel ?? "—")}
                        {h.exclude.length ? <span className="text-danger"> · {h.exclude.length} taken off</span> : null}
                        {h.level !== "people" && h.include.length ? <span className="text-muted"> · +{h.include.length} named</span> : null}
                      </span>
                    </span>
                  </Cell>
                  <Cell>
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : h.id)}
                      className="cursor-pointer text-[13px] text-[#5223E0] hover:underline"
                    >
                      {h.members.length} of {people.length} {expanded ? "▴" : "▾"}
                    </button>
                  </Cell>
                  <Cell align="right" onClick={() => undefined}>
                    <RowMenu
                      items={[
                        { label: "Edit", run: () => onEdit(h) },
                        { label: expanded ? "Hide who gets it" : "Who gets it", run: () => setOpen(expanded ? null : h.id) },
                        { label: "Remove", run: () => onRemove(h), danger: true },
                      ]}
                    />
                  </Cell>
                </Row>
                {expanded ? (
                  <tr>
                    <td colSpan={6} className="border-b border-line bg-canvas px-4 py-3">
                      <HolidayDetail h={h} names={names} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </Table>
      )}
      <p className="mt-3 text-[13px] text-muted">
        {shown.length} shown · {shown.filter((h) => h.onDate >= todayIso).length} ahead, {shown.filter((h) => h.onDate < todayIso).length} past.
      </p>
    </>
  );
}

function HolidayDetail({ h, names }: { h: HolidayEntry; names: Map<string, string> }) {
  return (
    <div className="grid grid-cols-[2fr_1fr] gap-6 text-[13px]">
      <div>
        <div className="mb-1.5 font-medium text-ink">
          Gets the day ({h.members.length})
          {h.places.length ? <span className="font-normal text-muted"> — {h.places.map((p) => p.label).join(", ")}</span> : null}
        </div>
        {h.members.length ? (
          <div className="flex flex-wrap gap-1">
            {h.members.map((m) => (
              <span key={m.userId} className="rounded-[9px] bg-surface px-2 py-0.5 text-[12px] text-body ring-1 ring-line">
                {names.get(m.userId) ?? "Not on your team"} <span className="text-muted">· {m.reasons.join(", ")}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-muted">Nobody on your team works where this is. Anybody allocated there later gets it.</p>
        )}
        {h.note ? <p className="mt-2 text-body">Note: {h.note}</p> : null}
      </div>
      <div className="space-y-2">
        <Allocations title="Given to by name" rows={h.include} />
        <Allocations title="Taken away from" rows={h.exclude} danger />
        <p className="text-[12px] text-muted">
          Added {h.createdByName ? `by ${h.createdByName}` : ""} on {longDay(calendarDate(new Date(h.createdAt)))}.
        </p>
      </div>
    </div>
  );
}

function Allocations({ title, rows, danger }: { title: string; rows: HolidayEntry["include"]; danger?: boolean }) {
  return (
    <div>
      <div className="font-medium text-ink">
        {title} ({rows.length})
      </div>
      {rows.length ? (
        <ul className="mt-0.5 space-y-0.5">
          {rows.map((a) => (
            <li key={a.userId} className={danger ? "text-danger" : "text-body"}>
              {a.name}
              {a.reason ? <span className="text-muted"> — {a.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">Nobody.</p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ by level */

function LevelsView({ calendar, todayIso, onEdit }: { calendar: HolidayCalendar; todayIso: string; onEdit: (h: HolidayEntry) => void }) {
  const { holidays, people } = calendar;
  const names = new Map(people.map((p) => [p.id, p.name]));
  const company = holidays.filter((h) => h.level === "company");

  /* Every place a holiday names, with its holidays and the people it reaches. */
  const byPlace = (level: HolidayLevel) => {
    const groups = new Map<string, { label: string; holidays: HolidayEntry[]; people: Set<string> }>();
    for (const h of holidays.filter((x) => x.level === level))
      for (const p of h.places) {
        const g = groups.get(p.id) ?? { label: p.label, holidays: [], people: new Set<string>() };
        g.holidays.push(h);
        for (const m of h.members) if (m.reasons.includes(p.label)) g.people.add(m.userId);
        groups.set(p.id, g);
      }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  };

  /* Each state the team works in, with who is there — whether or not it has a state holiday yet. */
  const teamStates = new Map<string, string[]>();
  for (const p of people) for (const s of p.states) teamStates.set(s, [...(teamStates.get(s) ?? []), p.name]);
  const stateGroups = byPlace("state");

  return (
    <div className="space-y-6">
      <Section title="Company-wide" count={company.length} sub={`Every one of the ${people.length} people on your team, except anybody it was taken from.`}>
        {company.length ? (
          <DayList holidays={company} todayIso={todayIso} onEdit={onEdit} extra={(h) => (h.exclude.length ? `not for ${h.exclude.map((a) => a.name).join(", ")}` : null)} />
        ) : (
          <p className="text-[13px] text-muted">No company-wide holiday this year.</p>
        )}
      </Section>

      <Section title="State" count={stateGroups.reduce((n, g) => n + g.holidays.length, 0)} sub="Each state, the people who work in it, and the days that are theirs.">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
          {[...new Set([...stateGroups.map((g) => g.label), ...teamStates.keys()])].sort().map((state) => {
            const g = stateGroups.find((x) => x.label === state);
            const there = teamStates.get(state) ?? [];
            return (
              <PlaceCard
                key={state}
                title={state}
                people={g ? [...g.people].map((id) => names.get(id) ?? "—") : there}
                holidays={g?.holidays ?? []}
                todayIso={todayIso}
                onEdit={onEdit}
              />
            );
          })}
        </div>
      </Section>

      {(["district", "city", "area"] as const).map((level) => {
        const groups = byPlace(level);
        return (
          <Section key={level} title={HOLIDAY_LEVEL_LABEL[level]} count={groups.reduce((n, g) => n + g.holidays.length, 0)}>
            {groups.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
                {groups.map((g) => (
                  <PlaceCard key={g.label} title={g.label} people={[...g.people].map((id) => names.get(id) ?? "—")} holidays={g.holidays} todayIso={todayIso} onEdit={onEdit} />
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted">No {level} holiday this year.</p>
            )}
          </Section>
        );
      })}

      <Section title="Named people & special days" count={levelCount(holidays, "people")} sub="Days given person by person — a community's festival, a family occasion.">
        {levelCount(holidays, "people") ? (
          <DayList
            holidays={holidays.filter((h) => h.level === "people")}
            todayIso={todayIso}
            onEdit={onEdit}
            extra={(h) => h.include.map((a) => a.name).join(", ")}
          />
        ) : (
          <p className="text-[13px] text-muted">No special day given to named people this year.</p>
        )}
      </Section>
    </div>
  );
}

const levelCount = (hs: HolidayEntry[], l: HolidayLevel) => hs.filter((h) => h.level === l).length;

function Section({ title, count, sub, children }: { title: string; count: number; sub?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-base font-semibold text-ink">
          {title} <span className="text-[13px] font-normal text-muted tabular-nums">· {count} {count === 1 ? "day" : "days"}</span>
        </h2>
        {sub ? <p className="text-[13px] text-muted">{sub}</p> : null}
      </div>
      {children}
    </section>
  );
}

function PlaceCard({
  title,
  people,
  holidays,
  todayIso,
  onEdit,
}: {
  title: string;
  people: string[];
  holidays: HolidayEntry[];
  todayIso: string;
  onEdit: (h: HolidayEntry) => void;
}) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-ink">{title}</span>
        <span className="text-[12px] text-muted">
          {holidays.length} {holidays.length === 1 ? "holiday" : "holidays"} · {people.length} {people.length === 1 ? "person" : "people"}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-body">{people.length ? people.join(", ") : <span className="text-muted">Nobody on your team works here.</span>}</p>
      <div className="mt-2 border-t border-divider pt-2">
        {holidays.length ? (
          <DayList holidays={holidays} todayIso={todayIso} onEdit={onEdit} compact />
        ) : (
          <p className="text-[12px] text-muted">No holiday of its own this year — only the company-wide days.</p>
        )}
      </div>
    </div>
  );
}

function DayList({
  holidays,
  todayIso,
  onEdit,
  extra,
  compact,
}: {
  holidays: HolidayEntry[];
  todayIso: string;
  onEdit: (h: HolidayEntry) => void;
  extra?: (h: HolidayEntry) => string | null;
  compact?: boolean;
}) {
  return (
    <ul className={cx("divide-y divide-divider", compact ? "" : "rounded-[6px] border border-line bg-surface")}>
      {holidays.map((h) => (
        <li key={h.id} className={cx("flex items-center gap-3 text-[13px]", compact ? "py-1" : "px-4 py-2")}>
          <span className={cx("w-[110px] flex-none tabular-nums", h.onDate < todayIso ? "text-muted" : "text-ink")}>{shortDay(h.onDate)}</span>
          <span className="min-w-0 flex-1 truncate text-ink">
            {h.name}
            {extra?.(h) ? <span className="text-muted"> — {extra(h)}</span> : null}
          </span>
          <button type="button" onClick={() => onEdit(h)} className="cursor-pointer text-[12px] text-[#5223E0] hover:underline">
            Edit
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ═══════════════════════════════════════════════════════════ by employee */

type PersonDay = {
  h: HolidayEntry;
  /** his · not his · taken (excluded) */
  state: "his" | "not" | "taken";
  why: string;
  given: boolean;
};

function daysFor(personId: string, holidays: HolidayEntry[]): PersonDay[] {
  return holidays.map((h) => {
    const member = h.members.find((m) => m.userId === personId);
    const taken = h.exclude.find((a) => a.userId === personId);
    const given = h.include.some((a) => a.userId === personId);
    if (taken) return { h, state: "taken", why: taken.reason ?? "Taken away", given };
    if (member) return { h, state: "his", why: member.reasons.join(", "), given };
    return { h, state: "not", why: h.level === "company" ? "—" : `Only ${h.audienceLabel ?? HOLIDAY_LEVEL_LABEL[h.level]}`, given };
  });
}

function PeopleView({
  calendar,
  todayIso,
  person,
  personHref,
  onError,
}: {
  calendar: HolidayCalendar;
  todayIso: string;
  person: string | null;
  personHref: (id: string | null) => string;
  onError: (e: string | null) => void;
}) {
  const { holidays, people, year } = calendar;
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();

  const rows = people
    .map((p) => {
      const days = daysFor(p.id, holidays);
      const his = days.filter((d) => d.state === "his");
      return {
        p,
        his,
        company: his.filter((d) => d.h.level === "company").length,
        regional: his.filter((d) => ["state", "district", "city", "area"].includes(d.h.level)).length,
        named: his.filter((d) => d.h.level === "people" || d.given).length,
        taken: days.filter((d) => d.state === "taken").length,
        next: his.find((d) => d.h.onDate >= todayIso)?.h ?? null,
      };
    })
    .filter((r) => !q || `${r.p.name} ${r.p.where}`.toLowerCase().includes(q));

  const chosen = people.find((p) => p.id === person) ?? null;

  if (!people.length)
    return <Empty title="Nobody on your team" body="Holidays are counted per person once somebody holds the Salesman App and is on your team." />;

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a salesman or a place"
          className="h-8 w-[280px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
        />
        <span className="text-[13px] text-muted">Click a name to see his year and give or take a day.</span>
      </div>
      <Table
        minWidth={1080}
        head={
          <>
            <HeadCell width={200}>Salesman</HeadCell>
            <HeadCell>Works in</HeadCell>
            <HeadCell width={130} align="right">
              Holidays {year}
            </HeadCell>
            <HeadCell width={110} align="right">
              Company
            </HeadCell>
            <HeadCell width={110} align="right">
              Regional
            </HeadCell>
            <HeadCell width={90} align="right">
              Named
            </HeadCell>
            <HeadCell width={100} align="right">
              Taken off
            </HeadCell>
            <HeadCell width={230}>Next</HeadCell>
          </>
        }
      >
        {rows.map((r, i) => (
          <Row key={r.p.id} striped={i % 2 === 1} selected={r.p.id === person}>
            <Cell>
              <Link href={personHref(r.p.id === person ? null : r.p.id)} scroll={false} className="font-medium text-ink hover:text-[#5223E0]">
                {r.p.name}
              </Link>
              {!r.p.active ? <span className="ml-1.5 text-[12px] text-muted">(inactive)</span> : null}
            </Cell>
            <Cell truncate={320} title={r.p.where || undefined}>
              {r.p.where || <span className="text-muted">No area allocated — company-wide days only</span>}
            </Cell>
            <Cell align="right">
              <span className="font-semibold text-ink tabular-nums">{r.his.length}</span>
            </Cell>
            <Cell align="right" className="tabular-nums">
              {r.company}
            </Cell>
            <Cell align="right" className="tabular-nums">
              {r.regional}
            </Cell>
            <Cell align="right" className="tabular-nums">
              {r.named}
            </Cell>
            <Cell align="right" className={cx("tabular-nums", r.taken ? "text-danger" : "")}>
              {r.taken}
            </Cell>
            <Cell truncate={230}>{r.next ? `${shortDay(r.next.onDate)} · ${r.next.name}` : <span className="text-muted">None left</span>}</Cell>
          </Row>
        ))}
      </Table>

      {chosen ? <PersonYear key={chosen.id} person={chosen} holidays={holidays} year={year} todayIso={todayIso} onError={onError} /> : null}
    </>
  );
}

function PersonYear({
  person,
  holidays,
  year,
  todayIso,
  onError,
}: {
  person: HolidayPersonRow;
  holidays: HolidayEntry[];
  year: number;
  todayIso: string;
  onError: (e: string | null) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [show, setShow] = React.useState<"all" | "his">("all");
  const [asking, setAsking] = React.useState<{ day: PersonDay; mode: "include" | "exclude" } | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const days = daysFor(person.id, holidays);
  const his = days.filter((d) => d.state === "his");
  const shown = show === "his" ? his : days;
  const byLevel = HOLIDAY_LEVELS.map((l) => [l, his.filter((d) => d.h.level === l).length] as const).filter(([, n]) => n);

  async function act(day: PersonDay, mode: "include" | "exclude" | "clear", why: string | null) {
    setBusy(true);
    let r;
    try {
      r = await setHolidayPerson({ holidayId: day.h.id, userId: person.id, mode, reason: why });
    } finally {
      setBusy(false);
    }
    if (!r.ok) {
      onError(r.error);
      return false;
    }
    onError(null);
    toast.push(r.message ?? "Saved.");
    router.refresh();
    return true;
  }

  return (
    <div className="mt-5 rounded-[6px] border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-divider px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {person.name} — {his.length} {his.length === 1 ? "holiday" : "holidays"} in {year}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {byLevel.length ? byLevel.map(([l, n]) => `${n} ${HOLIDAY_LEVEL_LABEL[l].toLowerCase()}`).join(" · ") : "No holiday reaches him this year."}
            {person.where ? ` · works in ${person.where}` : " · no area allocated"}
          </p>
        </div>
        <div className="flex gap-1">
          {(
            [
              ["all", `Whole calendar (${days.length})`],
              ["his", `His days (${his.length})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setShow(k)}
              className={cx(
                "h-7 cursor-pointer rounded-[14px] border px-3 text-[13px]",
                show === k ? "border-brand bg-brand-soft font-medium text-[#5223E0]" : "border-line text-body",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-muted">Nothing to show.</p>
      ) : (
        <ul className="divide-y divide-divider">
          {shown.map((d) => (
            <li key={d.h.id} className="flex items-center gap-4 px-5 py-2.5 text-[13px]">
              <span className={cx("w-[120px] flex-none tabular-nums", d.h.onDate < todayIso ? "text-muted" : "text-ink")}>{shortDay(d.h.onDate)}</span>
              <span className="w-[240px] flex-none truncate text-ink">{d.h.name}</span>
              <span className="w-[120px] flex-none">
                <LevelPill level={d.h.level} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {d.state === "his" ? (
                  <span className="text-success">✓ His — {d.why}</span>
                ) : d.state === "taken" ? (
                  <span className="text-danger">✕ Taken away — {d.why}</span>
                ) : (
                  <span className="text-muted">Not his · {d.why}</span>
                )}
              </span>
              <span className="flex flex-none gap-1.5">
                {d.state === "not" ? (
                  <Button size="sm" disabled={busy} onClick={() => (setReason(""), setAsking({ day: d, mode: "include" }))}>
                    Give him this day
                  </Button>
                ) : null}
                {d.state === "his" && !d.given ? (
                  <Button size="sm" tone="quiet" disabled={busy} onClick={() => (setReason(""), setAsking({ day: d, mode: "exclude" }))}>
                    Take it away
                  </Button>
                ) : null}
                {d.state === "his" && d.given ? (
                  <Button size="sm" tone="quiet" disabled={busy} title="Remove the allocation — he keeps the day only if the level reaches him." onClick={() => void act(d, "clear", null)}>
                    Remove allocation
                  </Button>
                ) : null}
                {d.state === "taken" ? (
                  <Button size="sm" disabled={busy} title="Put him back on whatever the holiday's level says." onClick={() => void act(d, "clear", null)}>
                    Give it back
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={asking !== null}
        onClose={() => setAsking(null)}
        width={460}
        title={asking?.mode === "include" ? `Give ${person.name} ${asking.day.h.name}` : `Take ${asking?.day.h.name ?? ""} from ${person.name}`}
        footer={
          <>
            <Button tone="quiet" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              tone={asking?.mode === "exclude" ? "danger" : "primary"}
              disabled={busy || (asking?.mode === "exclude" && !reason.trim())}
              title={asking?.mode === "exclude" && !reason.trim() ? "Say why — he will ask." : undefined}
              onClick={async () => {
                if (!asking) return;
                if (await act(asking.day, asking.mode, reason.trim() || null)) setAsking(null);
              }}
            >
              {busy ? "Saving…" : asking?.mode === "include" ? "Give the day" : "Take it away"}
            </Button>
          </>
        }
      >
        {asking ? (
          <div className="space-y-3 text-[13px]">
            <p className="text-body">
              {longDay(asking.day.h.onDate)} ·{" "}
              {asking.mode === "include"
                ? "becomes a holiday for him alone, on top of whatever the level says. His phone shows it at the next sync."
                : "becomes a working day for him: attendance expects a punch-in, and his phone stops showing it as his."}
            </p>
            <label className="block">
              <span className="mb-1 block font-medium text-ink">{asking.mode === "include" ? "Why (optional)" : "Why"}</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder={asking.mode === "include" ? "His village festival" : "Covering the Cuttack market, which stays open"}
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/* Calendar days, spelled from fixed names rather than `Intl`: the server's ICU
   and the browser's disagree on a short month ("Sep" against "Sept"), and that
   one letter is a hydration mismatch on every row. There is no time of day in
   these, so there is no zone to get wrong. */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parts(iso: string): { y: number; m: number; d: number; wd: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

function longDay(iso: string): string {
  const p = parts(iso);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

function shortDay(iso: string): string {
  const p = parts(iso);
  return `${WEEKDAYS[p.wd].slice(0, 3)}, ${p.d} ${MONTHS[p.m - 1].slice(0, 3)}`;
}

function weekday(iso: string): string {
  return WEEKDAYS[parts(iso).wd];
}
