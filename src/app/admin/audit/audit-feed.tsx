import Link from "next/link";
import { Badge, Card, EmptyState, Input, Select, cx, type Tone } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { addDays, clock, longDate } from "@/lib/format";
import { AUDIT_GROUPS, AUDIT_PAGE_SIZES, type AuditGroup, type Piece } from "@/lib/audit-labels";
import type { AuditEntry, AuditFeed, AuditFilters } from "@/lib/services/audit-feed-service";

/* ---------------------------------------------------------------------------
 * The audit log, read as sentences.
 *
 * Deliberately a SERVER component, like the funnel's audit trail: every filter
 * is a URL parameter and every page is a link, so a view somebody has narrowed
 * to "payments Deepa touched in September" can be bookmarked and sent. The one
 * piece of interaction — opening a row to see what changed — is a native
 * `<details>`, which needs no JavaScript at all.
 * ------------------------------------------------------------------------- */

const GROUP_TONE: Record<AuditGroup, Tone> = {
  money: "success",
  customers: "brand",
  field: "brand",
  factory: "neutral",
  hr: "neutral",
  access: "warn",
  settings: "warn",
  signin: "muted",
  other: "muted",
};

type Params = Record<string, string | undefined>;

function query(f: AuditFilters, over: Params = {}): string {
  const p: Params = {
    q: f.q ?? undefined,
    person: f.person ?? undefined,
    event: f.event ?? undefined,
    from: f.from ?? undefined,
    to: f.to ?? undefined,
    size: f.size === 50 ? undefined : String(f.size),
    combine: f.combine ? undefined : "0",
    page: f.page > 1 ? String(f.page) : undefined,
    ...over,
  };
  const s = new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
}

const tabHref = (slug: string, f: AuditFilters) =>
  ADMIN.audit(slug === "all" ? undefined : (slug as never)) + query(f, { page: undefined, event: undefined });
const pageHref = (f: AuditFilters, page: number) =>
  ADMIN.audit(f.group === "all" ? undefined : (f.group as never)) + query(f, { page: page > 1 ? String(page) : undefined });

export function AuditFeedScreen({ feed, filters, today }: { feed: AuditFeed; filters: AuditFilters; today: string }) {
  const f = { ...filters, page: feed.page };
  const filtered = !!(f.q || f.person || f.event || f.from || f.to);
  const first = feed.total ? (feed.page - 1) * feed.size + 1 : 0;
  const last = Math.min(feed.page * feed.size, feed.total);

  return (
    <div className="mt-1">
      {/* Group tabs, each saying how much it holds under the other filters. */}
      <nav aria-label="What kind" className="flex flex-wrap items-center gap-x-5 border-b border-line">
        {[{ slug: "all", label: "Everything", hint: "Every kind of event" }, ...AUDIT_GROUPS].map((g) => {
          const active = f.group === g.slug;
          const n = feed.groupCounts[g.slug as AuditGroup | "all"] ?? 0;
          return (
            <Link
              key={g.slug}
              href={tabHref(g.slug, f)}
              title={g.hint}
              aria-current={active ? "page" : undefined}
              className={cx(
                "-mb-px border-b-2 py-2.5 text-sm whitespace-nowrap no-underline hover:no-underline",
                active ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-body",
              )}
            >
              {g.label} <span className="text-[12px] text-muted tabular-nums">{n.toLocaleString("en-IN")}</span>
            </Link>
          );
        })}
      </nav>

      <form method="get" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.3fr_1.6fr_1fr_1fr_auto]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Search</span>
          <Input name="q" defaultValue={f.q ?? ""} placeholder="A customer or a person" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Done by</span>
          <Select name="person" defaultValue={f.person ?? ""} className="w-full">
            <option value="">Anybody</option>
            {feed.systemCount ? <option value="system">MahekOne itself ({feed.systemCount.toLocaleString("en-IN")})</option> : null}
            {feed.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.n.toLocaleString("en-IN")})
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">What happened</span>
          <Select name="event" defaultValue={f.event ?? ""} className="w-full">
            <option value="">Any event</option>
            {feed.events.map((e) => (
              <option key={e.action} value={e.action}>
                {e.label} ({e.n.toLocaleString("en-IN")})
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">From</span>
          <Input type="date" name="from" defaultValue={f.from ?? ""} max={today} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">To</span>
          <Input type="date" name="to" defaultValue={f.to ?? ""} max={today} />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="h-8.5 rounded-[4px] bg-brand px-3.5 text-sm font-medium whitespace-nowrap text-white hover:opacity-90"
          >
            Apply
          </button>
          {filtered ? (
            <Link href={tabHref(f.group, { ...f, q: null, person: null, event: null, from: null, to: null })} className="h-8.5 px-1 text-sm leading-8.5 text-muted">
              Clear
            </Link>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted sm:col-span-2 lg:col-span-6">
          <span className="flex items-center gap-2">
            Show
            <Select name="size" defaultValue={String(f.size)} className="h-7 text-[13px]">
              {AUDIT_PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            a page
          </span>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="combine" value="0" defaultChecked={!f.combine} />
            Show every event separately (normally a burst of the same event is one line)
          </label>
          <QuickRange f={f} today={today} />
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 text-[13px] text-muted">
        <span>
          {feed.total
            ? `Showing ${first.toLocaleString("en-IN")}–${last.toLocaleString("en-IN")} of ${feed.total.toLocaleString("en-IN")} events, newest first`
            : null}
        </span>
        <span>Read-only. Nothing here can be edited or deleted, including by an admin.</span>
      </div>

      {feed.entries.length === 0 ? (
        <Card className="mt-3">
          <EmptyState
            title={filtered ? "Nothing matches these filters" : "Nothing of this kind has been recorded"}
            body={
              filtered
                ? "Try a wider date range, another person, or clear the filters."
                : "The audit log is written as work happens, so this fills itself."
            }
          />
        </Card>
      ) : (
        <AuditEntries entries={feed.entries} today={today} />
      )}

      <Pager feed={feed} f={f} />
    </div>
  );
}

function QuickRange({ f, today }: { f: AuditFilters; today: string }) {
  const ranges: Array<[string, string, string]> = [
    ["Today", today, today],
    ["Yesterday", addDays(today, -1), addDays(today, -1)],
    ["Last 7 days", addDays(today, -6), today],
    ["Last 30 days", addDays(today, -29), today],
  ];
  return (
    <span className="flex flex-wrap items-center gap-2">
      {ranges.map(([label, from, to]) => {
        const on = f.from === from && f.to === to;
        return (
          <Link
            key={label}
            href={tabHref(f.group, { ...f, from, to })}
            className={cx("rounded-full border px-2 py-0.5 no-underline", on ? "border-brand text-ink" : "border-line text-muted hover:text-body")}
          >
            {label}
          </Link>
        );
      })}
    </span>
  );
}

function dayHeading(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return longDate(day);
}

/** Entries under day headings. Also drawn on a person's Audit tab. */
export function AuditEntries({ entries, today }: { entries: AuditEntry[]; today: string }) {
  const days: Array<{ day: string; rows: AuditEntry[] }> = [];
  for (const e of entries) {
    const last = days[days.length - 1];
    if (last?.day === e.day) last.rows.push(e);
    else days.push({ day: e.day, rows: [e] });
  }
  return (
    <div className="mt-3 space-y-5">
      {days.map((d) => (
        <section key={d.day}>
          <h3 className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{dayHeading(d.day, today)}</h3>
          <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            {d.rows.map((e, i) => (
              <Entry key={e.id} e={e} first={i === 0} />
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}

function Sentence({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((p, i) => {
        const gap = i ? " " : "";
        if (typeof p === "string") return <span key={i}>{gap + p}</span>;
        if ("strong" in p) return <strong key={i} className="font-medium text-ink">{gap + p.strong}</strong>;
        const href = p.ref === "customer" ? `/crm/customers/${p.id}` : p.ref === "user" ? ADMIN.person(p.id) : null;
        return (
          <span key={i}>
            {gap}
            {href ? (
              <Link href={href} className="font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-brand">
                {p.name}
              </Link>
            ) : (
              <strong className="font-medium text-ink">{p.name}</strong>
            )}
          </span>
        );
      })}
    </>
  );
}

function Entry({ e, first }: { e: AuditEntry; first: boolean }) {
  const hasDetail = e.changes.length > 0 || e.raw.before != null || e.raw.after != null || !!e.hat;
  const when = e.count > 1 && e.firstAt ? `${clock(new Date(e.firstAt))} – ${clock(new Date(e.at))}` : clock(new Date(e.at));
  return (
    <details className={cx("group px-5 py-3", first ? "" : "border-t border-canvas")}>
      <summary className={cx("flex list-none flex-wrap items-start gap-x-4 gap-y-1 sm:flex-nowrap", hasDetail ? "cursor-pointer" : "cursor-default")}>
        <span className="w-[92px] shrink-0 pt-px text-[13px] text-muted tabular-nums">{when}</span>
        <span className="min-w-0 flex-1 basis-[220px] text-sm leading-[21px] text-body">
          {e.actor ? (
            <Link href={ADMIN.person(e.actor.id)} className="font-medium text-ink no-underline hover:underline">
              {e.actor.name}
            </Link>
          ) : (
            <span className="font-medium text-ink" title="Written by a scheduled job, an import or a correction made outside the app">
              MahekOne
            </span>
          )}{" "}
          <Sentence pieces={e.says} />
          {e.count > 1 ? (
            <span className="ml-1.5 text-muted">— and {(e.count - 1).toLocaleString("en-IN")} more like it</span>
          ) : null}
          {e.note ? (
            <span className="mt-0.5 block text-[13px] text-muted italic group-open:line-clamp-none line-clamp-2">“{e.note}”</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {e.count > 1 ? <Badge tone="neutral">×{e.count.toLocaleString("en-IN")}</Badge> : null}
          <Badge tone={GROUP_TONE[e.group]}>{e.groupLabel}</Badge>
          {hasDetail ? (
            <span aria-hidden className="text-[11px] text-muted transition-transform group-open:rotate-90">
              ▶
            </span>
          ) : null}
        </span>
      </summary>
      {hasDetail ? (
        <div className="mt-3 space-y-3 text-[13px] sm:ml-[108px]">
          {e.changes.length ? (
            <table className="w-full max-w-[640px]">
              <thead>
                <tr className="text-left text-[11px] tracking-[0.04em] text-muted uppercase">
                  <th className="pb-1 font-medium">What</th>
                  <th className="pb-1 font-medium">Was</th>
                  <th className="pb-1 font-medium">Now</th>
                </tr>
              </thead>
              <tbody>
                {e.changes.map((c) => (
                  <tr key={c.field} className="align-top">
                    <td className="py-0.5 pr-4 text-muted">{c.field}</td>
                    <td className="py-0.5 pr-4 text-body">{c.from || <span className="text-muted">—</span>}</td>
                    <td className="py-0.5 text-ink">{c.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {e.hat ? <div className="text-muted">Allowed as {e.hat}.</div> : null}
          {e.count > 1 ? (
            <div className="text-muted">The details are for the most recent of the {e.count.toLocaleString("en-IN")}.</div>
          ) : null}
          <details>
            <summary className="cursor-pointer text-muted">For developers</summary>
            <pre className="mt-2 max-h-[280px] overflow-auto rounded-[4px] bg-canvas p-3 text-[12px] leading-[18px] whitespace-pre-wrap text-body">
              {JSON.stringify(
                { action: e.raw.action, entity: e.raw.entityType, id: e.raw.entityId, before: e.raw.before, after: e.raw.after },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      ) : null}
    </details>
  );
}

function Pager({ feed, f }: { feed: AuditFeed; f: AuditFilters }) {
  if (feed.pages <= 1) return null;
  /* First, last, and two either side of here — a log of three hundred pages
     must not draw three hundred links. */
  const want = new Set([1, feed.pages, feed.page - 2, feed.page - 1, feed.page, feed.page + 1, feed.page + 2]);
  const nums = [...want].filter((n) => n >= 1 && n <= feed.pages).sort((a, b) => a - b);
  const link = "inline-flex h-8 min-w-8 items-center justify-center rounded-[4px] border px-2 text-[13px] no-underline";
  return (
    <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <span className="text-[13px] text-muted">
        Page {feed.page.toLocaleString("en-IN")} of {feed.pages.toLocaleString("en-IN")}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {feed.page > 1 ? (
          <Link href={pageHref(f, feed.page - 1)} className={cx(link, "border-line text-body")}>
            ← Newer
          </Link>
        ) : null}
        {nums.map((n, i) => (
          <span key={n} className="flex items-center gap-1.5">
            {i && n - nums[i - 1] > 1 ? <span className="text-muted">…</span> : null}
            <Link
              href={pageHref(f, n)}
              aria-current={n === feed.page ? "page" : undefined}
              className={cx(link, n === feed.page ? "border-brand font-medium text-ink" : "border-line text-muted hover:text-body")}
            >
              {n.toLocaleString("en-IN")}
            </Link>
          </span>
        ))}
        {feed.page < feed.pages ? (
          <Link href={pageHref(f, feed.page + 1)} className={cx(link, "border-line text-body")}>
            Older →
          </Link>
        ) : null}
      </span>
    </nav>
  );
}
