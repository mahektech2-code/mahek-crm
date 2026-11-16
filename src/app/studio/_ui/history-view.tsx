import Link from "next/link";
import { Badge, Button, Callout, Card, EmptyState, Input, Select, Td, Th, buttonClass, type Tone } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { LANGUAGE_NAMES, type Language } from "@/lib/studio/domain/language";
import {
  HISTORY_MODES,
  HISTORY_STATUSES,
  HISTORY_STATUS_HINT,
  HISTORY_STATUS_LABEL,
  MODE_LABEL,
  activeFilterCount,
  type HistoryFilters,
  type HistoryStatus,
} from "@/lib/studio/domain/history";
import type { HistoryPage, HistoryRow, PanelData } from "@/lib/studio/history-service";

/* My posters, with the forwarding history in the same table. Server-rendered: filters are a plain GET form, a row is a
   link that adds ?open=<key>, and the panel is drawn from that — nothing here asks the browser to be clever. */

const TONE: Record<HistoryStatus, Tone> = { pending: "muted", opened: "brand", sent: "success", skipped: "warn", not_forwarded: "neutral" };

export function StatusBadge({ status }: { status: HistoryStatus }) {
  return (
    <Badge tone={TONE[status]} title={HISTORY_STATUS_HINT[status]} className={status === "not_forwarded" ? "font-normal text-faint" : undefined}>
      {HISTORY_STATUS_LABEL[status]}
    </Badge>
  );
}

export type QueryState = { whose: "mine" | "team"; filters: HistoryFilters; open: string | null };

export function hrefFor(s: QueryState, over: Record<string, string | number | null> = {}): string {
  const p = new URLSearchParams();
  const f = s.filters;
  const base: Record<string, string | number | null> = {
    whose: s.whose,
    q: f.q,
    poster: f.poster,
    recipient: f.recipient,
    mode: f.mode,
    status: f.status,
    from: f.from,
    to: f.to,
    user: f.user,
    show: f.show === "forwarded" ? "forwarded" : null,
    page: f.page > 1 ? f.page : null,
    open: s.open,
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v !== null && v !== "" && v !== undefined) p.set(k, String(v));
  return `/studio/posters?${p.toString()}`;
}

export function thumbOf(r: HistoryRow): string {
  return r.kind === "forward"
    ? `/api/studio/forwards/${encodeURIComponent(r.refId)}/image?thumb=1`
    : `/api/studio/designs/${encodeURIComponent(r.templateId ?? "")}/preview?v=${encodeURIComponent(r.templateVersion ?? "")}`;
}

function Thumb({ r, size = 36 }: { r: HistoryRow; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- our own routes; small, lazy
    <img src={thumbOf(r)} alt="" loading="lazy" width={size} height={size} className="shrink-0 rounded-control bg-surface-2 object-cover" style={{ width: size, height: size }} />
  );
}

const subtitleOf = (r: HistoryRow) =>
  r.kind === "forward" ? "Uploaded poster" : `${LANGUAGE_NAMES[r.language as Language] ?? r.language ?? ""}${r.mode === "bulk_run" ? " · made in a poster run" : " · made for this recipient"}`;

export function FilterBar({ s, page }: { s: QueryState; page: HistoryPage }) {
  const f = s.filters;
  const n = activeFilterCount(f);
  return (
    <form method="get" action="/studio/posters" className="mb-3 rounded-card border border-line bg-surface p-3" role="search">
      <input type="hidden" name="whose" value={s.whose} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input name="q" defaultValue={f.q} placeholder="Search poster, lead or customer…" aria-label="Search" maxLength={80} className="sm:col-span-2" />
        <Input name="poster" defaultValue={f.poster} placeholder="Poster" aria-label="Poster" maxLength={80} />
        <Input name="recipient" defaultValue={f.recipient} placeholder="Lead / Customer" aria-label="Lead or customer" maxLength={80} />
        <Select name="mode" defaultValue={f.mode ?? ""} aria-label="Mode">
          <option value="">Any mode</option>
          {HISTORY_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m].main}
              {MODE_LABEL[m].sub ? ` · ${MODE_LABEL[m].sub}` : ""}
            </option>
          ))}
        </Select>
        <Select name="status" defaultValue={f.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          {HISTORY_STATUSES.map((st) => (
            <option key={st} value={st}>
              {HISTORY_STATUS_LABEL[st]}
            </option>
          ))}
        </Select>
        <Input type="date" name="from" defaultValue={f.from ?? ""} aria-label="From date" />
        <Input type="date" name="to" defaultValue={f.to ?? ""} aria-label="To date" />
        {s.whose === "team" && page.people.length ? (
          <Select name="user" defaultValue={f.user ?? ""} aria-label="Sent by">
            <option value="">Anyone</option>
            {page.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select name="show" defaultValue={f.show} aria-label="Show">
          <option value="all">All posters</option>
          <option value="forwarded">Forwarded only</option>
        </Select>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm">
          Apply{n ? ` (${n})` : ""}
        </Button>
        {n || f.q ? (
          <Link href={`/studio/posters?whose=${s.whose}`} className={buttonClass({ size: "sm" })}>
            Clear all
          </Link>
        ) : null}
      </div>
    </form>
  );
}

export function HistoryTable({ s, page }: { s: QueryState; page: HistoryPage }) {
  const team = s.whose === "team";
  return (
    <>
      <Card className="hidden md:block">
        <table className="w-full border-collapse" data-testid="history-table">
          <thead>
            <tr>
              <Th>Poster</Th>
              <Th>Lead / Customer</Th>
              <Th>Mode</Th>
              {team ? <Th>By</Th> : null}
              <Th>Last action</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((r) => (
              <tr key={r.key} data-key={r.key} data-status={r.status} className={`border-t border-divider ${s.open === r.key ? "bg-brand-soft" : ""}`}>
                <Td>
                  <Link href={hrefFor(s, { open: r.key })} className="flex items-center gap-2.5 no-underline hover:no-underline">
                    <Thumb r={r} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-brand">{r.title}</span>
                      <span className="block truncate text-[12.5px] text-muted">{subtitleOf(r)}</span>
                    </span>
                  </Link>
                </Td>
                <Td>
                  <div className="font-medium">{r.company}</div>
                  <div className="text-[12.5px] text-muted">{r.recordRemoved ? "Record removed" : r.contact || r.place || ""}</div>
                </Td>
                <Td>
                  {MODE_LABEL[r.mode].main}
                  {MODE_LABEL[r.mode].sub ? <div className="text-[12.5px] text-muted">{MODE_LABEL[r.mode].sub}</div> : null}
                </Td>
                {team ? <Td>{r.createdByName}</Td> : null}
                <Td>{r.status === "not_forwarded" ? <span className="text-faint">made {stamp(r.createdAt)}</span> : stamp(r.actionAt ?? r.at)}</Td>
                <Td>
                  <StatusBadge status={r.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ul className="space-y-2 md:hidden" data-testid="history-cards">
        {page.rows.map((r) => (
          <li key={r.key} data-key={r.key}>
            <Link href={hrefFor(s, { open: r.key })} className="flex gap-3 rounded-card border border-line bg-surface p-3 no-underline hover:no-underline">
              <Thumb r={r} size={44} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-ink">{r.company}</span>
                  <StatusBadge status={r.status} />
                </span>
                <span className="block truncate text-[12.5px] text-muted">
                  {r.title} · {MODE_LABEL[r.mode].main}
                  {MODE_LABEL[r.mode].sub ? ` · ${MODE_LABEL[r.mode].sub}` : ""}
                </span>
                <span className="block text-[12.5px] text-muted">
                  {team ? `${r.createdByName} · ` : ""}
                  {r.status === "not_forwarded" ? `made ${stamp(r.createdAt)}` : stamp(r.actionAt ?? r.at)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pager({ s, page }: { s: QueryState; page: HistoryPage }) {
  if (page.pageCount <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-muted">
      <span>
        Page {page.page} of {page.pageCount} · {page.total} in all
      </span>
      <span className="flex gap-2">
        {page.page > 1 ? (
          <Link href={hrefFor({ ...s, open: null }, { page: page.page - 1 })} className={buttonClass({ size: "sm" })}>
            Previous
          </Link>
        ) : null}
        {page.page < page.pageCount ? (
          <Link href={hrefFor({ ...s, open: null }, { page: page.page + 1 })} className={buttonClass({ size: "sm" })}>
            Next
          </Link>
        ) : null}
      </span>
    </div>
  );
}

export function HistoryNotice() {
  return (
    <Callout tone="info" className="!mb-3">
      Marked Sent means the person told MahekOne they sent it — not that WhatsApp delivered it. A poster that was only made, never shared, shows “Not forwarded”.
    </Callout>
  );
}

export function HistoryEmpty({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <EmptyState title="No records match these filters" action={<Link href="/studio/posters" className={buttonClass({ variant: "primary" })}>Clear filters</Link>} />
  ) : (
    <EmptyState title="No posters yet" action={<Link href="/studio/make" className={buttonClass({ variant: "primary" })}>Make a poster</Link>} />
  );
}

export function HistoryPanel({ s, data }: { s: QueryState; data: PanelData }) {
  const r = data.row;
  const big = r.kind === "forward" ? `/api/studio/forwards/${encodeURIComponent(r.refId)}/image` : `/api/studio/posters/${encodeURIComponent(r.refId)}/image?format=jpeg`;
  const close = hrefFor(s, { open: null });
  return (
    <aside
      aria-label="Forwarding details"
      data-testid="history-panel"
      className="fixed inset-x-0 bottom-0 z-40 max-h-[85vh] overflow-y-auto rounded-t-card border border-line bg-surface p-4 shadow-pop md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[380px] md:rounded-none md:border-y-0 md:border-r-0"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-ink">{r.title}</h2>
        <Link href={close} aria-label="Close" className="text-muted no-underline hover:text-ink">
          ✕
        </Link>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- our own route */}
      <img src={big} alt={r.title} loading="lazy" className="my-3 max-h-56 w-full rounded-control bg-surface-2 object-contain" />
      <dl className="grid grid-cols-[84px_1fr] gap-x-2 gap-y-1 text-[13px]">
        <dt className="text-muted">Recipient</dt>
        <dd className="font-medium">
          {r.company}
          {r.recordRemoved ? <span className="font-normal text-muted"> · Record removed</span> : null}
        </dd>
        <dt className="text-muted">Mode</dt>
        <dd>
          {MODE_LABEL[r.mode].main}
          {MODE_LABEL[r.mode].sub ? ` (${MODE_LABEL[r.mode].sub})` : ""}
        </dd>
        <dt className="text-muted">Sent by</dt>
        <dd>{r.createdByName}</dd>
        <dt className="text-muted">Status</dt>
        <dd>
          <StatusBadge status={r.status} />
        </dd>
      </dl>
      <p className="mt-2 text-[12.5px] text-muted">{HISTORY_STATUS_HINT[r.status]} Marked Sent is the person’s own record, not WhatsApp delivery.</p>

      <h3 className="mb-1 mt-4 text-[12px] font-semibold uppercase tracking-label text-brand">Timeline</h3>
      <ol className="space-y-1 border-l-2 border-brand-soft pl-3 text-[13px]" data-testid="panel-timeline">
        {data.timeline.map((t, i) => (
          <li key={i}>
            <b>{stamp(t.at)}</b> · {t.text}
          </li>
        ))}
      </ol>
      {data.notes.length ? (
        <p className="mt-2 text-[12.5px] text-muted">
          Also recorded (not forwarding): {data.notes.map((n) => `${n.text} ${stamp(n.at)}`).join("; ")}
        </p>
      ) : null}

      {data.run.length > 1 ? (
        <>
          <h3 className="mb-1 mt-4 text-[12px] font-semibold uppercase tracking-label text-brand">
            {data.runLabel} ({data.run.length})
          </h3>
          <ul className="divide-y divide-divider text-[13px]" data-testid="panel-run">
            {data.run.map((x) => (
              <li key={x.key} className="flex items-center justify-between gap-2 py-1.5">
                <Link href={hrefFor(s, { open: x.key })} className={x.current ? "font-semibold" : ""}>
                  {x.company}
                </Link>
                <StatusBadge status={x.status} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {data.otherRuns.length ? (
        <>
          <h3 className="mb-1 mt-4 text-[12px] font-semibold uppercase tracking-label text-brand">Same picture, other runs</h3>
          <ul className="space-y-0.5 text-[13px]" data-testid="panel-other-runs">
            {data.otherRuns.map((o) => (
              <li key={o.id}>
                <Link href={`/studio/forward/${encodeURIComponent(o.id)}`}>{stamp(o.at)}</Link> · {o.people} {o.people === 1 ? "person" : "people"}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="mt-4 text-[13px]">
        <Link href={r.kind === "forward" ? `/studio/forward/${encodeURIComponent(r.refId)}` : `/studio/posters/${encodeURIComponent(r.refId)}`}>{r.kind === "forward" ? "Open forward list" : "Open poster"}</Link>
      </div>
    </aside>
  );
}
