import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { ADMIN, ADMIN_TABS } from "@/lib/admin-routes";
import type { Piece } from "@/lib/audit-labels";
import { APP_TIMEZONE } from "@/lib/business-date";
import type {
  AuditEntry,
  AuditFeed,
  AuditFilters,
} from "@/lib/services/audit-feed-service";
import { Card, CardHead, Mono, Pill, type Tone } from "../_shell/kit";
import { CsvButton } from "../roles/csv-button";

/**
 * The Audit log drawn to the canvas: group chips, one navy-headed table of
 * When · Who · Hat · Did · Record, and the line somebody opened beside it with
 * what changed. Every filter is still the service's, in SQL — this file only
 * draws what `auditFeed` read and builds the links that change it.
 */

const CHIP: Record<string, string> = {
  customers: "Customers",
  field: "Field",
  access: "Access",
  settings: "Settings",
};

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "All time" },
] as const;

export function AuditLogScreen({
  feed,
  filters,
  today,
  open,
}: {
  feed: AuditFeed;
  filters: AuditFilters;
  today: string;
  open: string | null;
}) {
  const link = linker(filters, open);
  const picked =
    feed.entries.find((e) => e.id === open) ?? feed.entries[0] ?? null;
  const eventLabel = new Map(feed.events.map((e) => [e.action, e.label]));
  const did = (e: AuditEntry) =>
    sentenceCase(eventLabel.get(e.raw.action) ?? text(e.says));

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {ADMIN_TABS.audit.map((g) => (
          <Link
            key={g.slug}
            href={link({ page: null, open: null }, g.slug)}
            className={cx(
              "inline-flex h-[34px] items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold whitespace-nowrap no-underline hover:no-underline",
              filters.group === g.slug
                ? "border-ink bg-ink text-white"
                : "border-line bg-surface text-ink hover:border-line-strong",
            )}
          >
            {CHIP[g.slug] ?? g.label}
            {g.slug !== "all" &&
            feed.groupCounts[g.slug as keyof AuditFeed["groupCounts"]] ? (
              <span
                className={cx(
                  "text-xs",
                  filters.group === g.slug ? "text-[#c9d1e3]" : "text-muted",
                )}
              >
                {feed.groupCounts[g.slug as keyof AuditFeed["groupCounts"]]}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      <div
        className="grid items-start gap-[18px]"
        style={{ gridTemplateColumns: "minmax(0,1fr) 380px" }}
      >
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["When", "Who", "Hat", "Did", "Record"].map((h) => (
                    <th
                      key={h}
                      className="bg-ink px-3.5 py-[9px] text-left text-xs font-semibold whitespace-nowrap text-white normal-case"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {feed.entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="h-24 text-center text-muted">
                      Nothing in the log matches that.
                    </td>
                  </tr>
                ) : (
                  feed.entries.map((e) => {
                    const on = picked?.id === e.id;
                    const rec = recordOf(e);
                    const tone = toneOf(e.raw.action);
                    const href = link({ open: e.id });
                    return (
                      <tr
                        key={e.id}
                        className={cx("group", on && "[&>td]:bg-[#f7f5ff]")}
                      >
                        <Cell href={href} className="text-body tabular-nums">
                          {when(e.at, e.day, today)}
                          {e.count > 1 ? (
                            <span className="ml-1 text-muted">×{e.count}</span>
                          ) : null}
                        </Cell>
                        <Cell href={href} className="font-semibold text-ink">
                          {e.actor ? (
                            firstName(e.actor.name)
                          ) : (
                            <span className="font-normal text-muted">
                              System
                            </span>
                          )}
                        </Cell>
                        <Cell href={href}>
                          {e.hat ? (
                            <Pill
                              tone={
                                hatShort(e.hat) === "Platform"
                                  ? "muted"
                                  : "brand"
                              }
                            >
                              {hatShort(e.hat)}
                            </Pill>
                          ) : null}
                        </Cell>
                        <Cell href={href}>
                          {tone ? (
                            <Pill tone={tone}>{did(e)}</Pill>
                          ) : (
                            <span className="text-body">{did(e)}</span>
                          )}
                        </Cell>
                        <Cell
                          href={href}
                          className="max-w-[220px] truncate text-body"
                        >
                          {rec ? (
                            rec.name
                          ) : e.raw.entityId && e.raw.entityId !== e.actor?.id ? (
                            <Mono className="text-muted">{e.raw.entityId}</Mono>
                          ) : null}
                        </Cell>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {feed.pages > 1 ? (
            <div className="flex items-center gap-3 border-t border-divider px-[18px] py-3 text-muted">
              <span className="flex-1">
                Page {feed.page} of {feed.pages} ·{" "}
                {feed.total.toLocaleString("en-IN")} lines
              </span>
              {feed.page > 1 ? (
                <Link
                  href={link({ page: String(feed.page - 1), open: null })}
                  className="font-semibold text-ink"
                >
                  ← Newer
                </Link>
              ) : null}
              {feed.page < feed.pages ? (
                <Link
                  href={link({ page: String(feed.page + 1), open: null })}
                  className="font-semibold text-ink"
                >
                  Older →
                </Link>
              ) : null}
            </div>
          ) : null}
        </Card>

        {picked ? <Detail e={picked} did={did(picked)} /> : <div />}
      </div>
    </>
  );
}

/** The search, the range and Export, for the page's title row. */
export function AuditActions({
  feed,
  filters,
  today,
}: {
  feed: AuditFeed;
  filters: AuditFilters;
  today: string;
}) {
  const link = linker(filters, null);
  const range =
    RANGES.find(
      (r) =>
        r.days > 0 &&
        filters.from === shiftDay(today, -(r.days - 1)) &&
        !filters.to,
    ) ?? (filters.from || filters.to ? null : RANGES[3]);
  const nextRange =
    RANGES[(RANGES.indexOf(range ?? RANGES[3]) + 1) % RANGES.length];
  const csv = feed.entries.map((e) => [
    stamp(e.at),
    e.actor?.name ?? "System",
    e.hat ?? "",
    `${e.actor?.name ?? "System"} ${text(e.says)}`,
    recordOf(e)?.name ?? e.raw.entityId ?? "",
    e.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join("; "),
  ]);
  return (
    <>
      <form className="flex items-center gap-2.5">
        {filters.from ? (
          <input type="hidden" name="from" value={filters.from} />
        ) : null}
        {filters.to ? (
          <input type="hidden" name="to" value={filters.to} />
        ) : null}
        {filters.person ? (
          <input type="hidden" name="person" value={filters.person} />
        ) : null}
        {filters.event ? (
          <input type="hidden" name="event" value={filters.event} />
        ) : null}
        <input
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="Person, record or action"
          aria-label="Find in the audit log"
          className="h-9 w-[260px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink"
        />
      </form>
      <Link
        href={link({
          from: nextRange.days ? shiftDay(today, -(nextRange.days - 1)) : null,
          to: null,
          page: null,
          open: null,
        })}
        className="inline-flex h-9 items-center rounded-control border border-line-strong bg-surface px-3.5 text-[13px] font-semibold whitespace-nowrap text-ink no-underline hover:bg-[#f7f9fc] hover:no-underline"
      >
        {range
          ? range.label
          : `${filters.from ?? "…"} – ${filters.to ?? "now"}`}
      </Link>
      <CsvButton
        name="audit-log"
        headers={["When", "Who", "Hat", "What", "Record", "Changes"]}
        rows={csv}
        filters={[filters.group, filters.q, filters.from, filters.to]}
      />
    </>
  );
}

function linker(filters: AuditFilters, open: string | null) {
  return (
    over: Partial<Record<string, string | null>>,
    group: string = filters.group,
  ) => {
    const p = new URLSearchParams();
    const v: Record<string, string | null> = {
      q: filters.q,
      person: filters.person,
      event: filters.event,
      from: filters.from,
      to: filters.to,
      page: filters.page > 1 ? String(filters.page) : null,
      size: filters.size !== 50 ? String(filters.size) : null,
      combine: filters.combine ? null : "0",
      open,
      ...over,
    };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    const base = ADMIN.audit(group === "all" ? undefined : (group as never));
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
}

function Cell({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className="h-[49px] border-b border-divider p-0 align-middle">
      <Link
        href={href}
        scroll={false}
        className={cx(
          "flex h-[48px] items-center px-3.5 no-underline hover:no-underline",
          className,
        )}
      >
        {children}
      </Link>
    </td>
  );
}

function Detail({ e, did }: { e: AuditEntry; did: string }) {
  const rec = recordOf(e);
  return (
    <Card>
      <CardHead
        title={did}
        actions={<span className="text-muted tabular-nums">{clock(e.at)}</span>}
      />
      <div className="flex flex-col gap-3.5 px-[18px] py-4">
        <Fact label="Who">
          {e.actor ? (
            <Link
              href={ADMIN.person(e.actor.id)}
              className="text-ink no-underline hover:underline"
            >
              {e.actor.name}
            </Link>
          ) : (
            "MahekOne, on its own"
          )}
          {e.hat ? <span className="text-muted"> · {e.hat}</span> : null}
        </Fact>
        <Fact label="What happened">
          <span className="text-body">
            {e.actor?.name ?? "MahekOne"} <Sentence pieces={e.says} />
          </span>
        </Fact>
        {rec ? (
          <Fact label={rec.ref === "customer" ? "Customer" : "Person"}>
            {rec.ref === "user" ? (
              <Link href={ADMIN.person(rec.id)} className="text-brand">
                {rec.name}
              </Link>
            ) : (
              <span className="text-brand-deep">{rec.name}</span>
            )}
          </Fact>
        ) : null}
        {e.note ? <Fact label="Note">“{e.note}”</Fact> : null}
        <Fact label="When">{stamp(e.at)}</Fact>
      </div>
      {e.changes.length ? (
        <table className="w-full border-collapse border-t border-divider text-[13px]">
          <thead>
            <tr>
              {["Field", "Before", "After"].map((h) => (
                <th
                  key={h}
                  className="bg-page px-3.5 py-2.5 text-left text-xs font-semibold text-muted normal-case"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {e.changes.map((c, i) => {
              const same = c.from === c.to;
              return (
                <tr key={i}>
                  <td className="h-10 border-t border-divider px-3.5 text-body">
                    {c.field}
                  </td>
                  <td
                    className={cx(
                      "h-10 border-t border-divider px-3.5",
                      same
                        ? "text-body"
                        : "font-semibold text-danger line-through",
                    )}
                  >
                    {c.from}
                  </td>
                  <td
                    className={cx(
                      "h-10 border-t border-divider px-3.5",
                      same ? "text-body" : "font-semibold text-success",
                    )}
                  >
                    {c.to}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted">{label}</div>
      <div className="text-[14px] text-ink">{children}</div>
    </div>
  );
}

function Sentence({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((p, i) => (
        <span key={i}>
          {i ? " " : ""}
          {typeof p === "string" ? (
            p
          ) : "strong" in p ? (
            <b className="font-semibold text-ink">{p.strong}</b>
          ) : (
            <b className="font-semibold text-ink">{p.name}</b>
          )}
        </span>
      ))}
    </>
  );
}

/* ----------------------------------------------------------------- helpers */

const text = (pieces: Piece[]) =>
  pieces
    .map((p) => (typeof p === "string" ? p : "strong" in p ? p.strong : p.name))
    .join(" ");
const sentenceCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const firstName = (n: string) => n.split(/\s+/)[0];

function recordOf(
  e: AuditEntry,
): { ref: "customer" | "user" | "employee"; id: string; name: string } | null {
  for (const p of e.says) if (typeof p !== "string" && "ref" in p) return p;
  return null;
}

/** "manager in Accounts" → "Accounts M"; the platform administrator → "Platform". */
function hatShort(hat: string): string {
  const m = /^(\w+)(?: in (.+))?$/.exec(hat);
  if (!m) return hat;
  const [, role, where] = m;
  if (role === "admin" && (!where || where === "Admin")) return "Platform";
  const app =
    (where ?? "")
      .replace(/^the /, "")
      .replace(/ (desk|app)$/, "")
      .split(" ")[0] || "";
  const lv =
    role === "admin"
      ? "Ad"
      : role === "manager"
        ? "M"
        : role === "associate"
          ? "A"
          : role;
  return app ? `${app} ${lv}` : lv;
}

function toneOf(action: string): Tone | null {
  if (/impersonate/.test(action)) return "warn";
  if (/(decline|reject|revers|bounce|void)/.test(action)) return "danger";
  if (/(approve|confirm)/.test(action)) return "ok";
  return null;
}

const fmt = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, ...o });
const CLOCK = fmt({ hour: "2-digit", minute: "2-digit", hour12: false });
const DAY = fmt({ day: "numeric", month: "short" });
const clock = (at: string) => CLOCK.format(new Date(at));
const stamp = (at: string) => `${DAY.format(new Date(at))} ${clock(at)}`;
const when = (at: string, day: string, today: string) =>
  day === today ? clock(at) : stamp(at);

/** A calendar date moved by whole days, as text — no clock is read. */
function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
