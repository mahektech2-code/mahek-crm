"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { Callout, Card, Td, Th, Tr, cx } from "@/components/ui/primitives";
import { CRIT, STATUS, daysColour, daysLabel } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { CardHead, StatusPill, fd, nf, useDensity } from "./kit";

/* ---------------------------------------------------------------------------
 * The register's own parts, in the ERP's v4 look: the attention row
 * (dashboard, my work), and the generic blocks its screens are built from —
 * a table, a list, a stat tile, bars and an alert — on the shared Card,
 * table cells, Callout and EmptyState, all link-driven so a server page can
 * render them without handing a function across.
 * ------------------------------------------------------------------------- */

export function countdown(a: AssetLite): { cd: string; date: string } {
  if (a.model === "term_contract" && a.noticeDays) {
    return { cd: a.actionIn == null ? "No expiry" : a.actionIn >= 0 ? `${nf(a.actionIn)} days to notice` : "Notice passed", date: `Notice by ${fd(a.actionDate)}` };
  }
  return { cd: daysLabel(a.d), date: a.endDate ? `${a.model === "subscription" ? "Renews" : a.d != null && a.d < 0 ? "Expired" : "Expires"} ${fd(a.endDate)}` : "No expiry" };
}

/** The attention row: title + status, meta, optional consequence, the countdown on the right; the importance is the left edge. */
export function AttentionRow({ a, conseq }: { a: AssetLite; conseq?: boolean }) {
  const tight = useDensity() === "compact";
  const { cd, date } = countdown(a);
  const show = conseq && a.crit === 4;
  return (
    <Link
      href={`/locker/assets/${a.id}`}
      className={cx("flex w-full items-start gap-5 border-t border-l-[3px] border-t-divider bg-surface px-5 text-left no-underline first:border-t-0 hover:bg-canvas hover:no-underline", tight ? "py-2.5" : "py-3.5")}
      style={{ borderLeftColor: CRIT[a.crit].edge }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{a.title}</span>
          <StatusPill status={a.status} />
        </span>
        <span className="mt-0.5 block text-[13px] text-muted">{[a.typeName, a.siteName ?? a.entityName ?? "Company-wide", a.ownerName ? `Owner ${a.ownerName}` : "No owner"].join(" · ")}</span>
        {show ? <span className="mt-1.5 block text-[13px] leading-[19px] text-pretty text-body">{a.consequence || "If this runs out, the work it allows must stop."}</span> : null}
      </span>
      <span className="min-w-[120px] flex-none text-right">
        <span className="block text-[22px] leading-[26px] font-semibold text-ink" style={a.d != null && a.d < 0 ? { color: daysColour(a.d, a.status) } : undefined}>
          {cd}
        </span>
        <span className="block text-xs text-muted">{date}</span>
      </span>
    </Link>
  );
}

/* ---------------------------------------------------------------- blocks */

/** A block's frame, as a class: the shared Card's border, radius and surface. */
export function blockClass(wide?: boolean): string {
  return cx("min-w-0 overflow-hidden rounded-card border border-line bg-surface", wide && "col-span-full");
}

/** Kept for callers that still spread it; the frame is the class above. */
export const blockStyle = (_vault?: boolean, wide?: boolean): CSSProperties => ({ gridColumn: wide ? "1 / -1" : "auto", minWidth: 0 });

export function BlockHead({ title, sub, right, vault }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; vault?: boolean }) {
  return <CardHead title={title} sub={sub} right={right} vault={vault} />;
}

/** A cell: text and a line under it, or any node. `cls` is token classes for the cell (weight, colour, alignment). */
export type Cell = { t?: ReactNode; sub?: ReactNode; style?: CSSProperties; cls?: string; node?: ReactNode };
export type GenRow = { href?: string; edge?: string | null; bg?: string; cells: Cell[] };

/** A column's width as a share of the table, from the design's px / minmax / fr template. */
function weight(t: string): number {
  const m = /^minmax\((\d+)px,\s*([\d.]+)fr\)$/.exec(t);
  if (m) return Math.max(+m[1], +m[2] * 130);
  const p = /^(\d+)px$/.exec(t);
  if (p) return +p[1];
  const f = /^minmax\(0,\s*([\d.]+)fr\)$/.exec(t) ?? /^([\d.]+)fr$/.exec(t);
  if (f) return +f[1] * 130;
  return 130;
}

export function GenTable({ title, sub, cols, rows, emptyLine = "Nothing to show.", vault, wide, right, pageSize = 25 }: { title?: ReactNode; sub?: ReactNode; cols: [string, string][]; rows: GenRow[]; emptyLine?: string; vault?: boolean; wide?: boolean; right?: ReactNode; pageSize?: number }) {
  const compact = useDensity() === "compact";
  const router = useRouter();
  const ws = cols.map((c) => weight(c[1]));
  const total = ws.reduce((a, b) => a + b, 0) || 1;
  const shown = rows.slice(0, pageSize * 8);
  return (
    <div className={blockClass(wide)}>
      {title ? <BlockHead title={title} sub={sub} vault={vault} right={right} /> : null}
      {rows.length ? (
        <div>
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              {ws.map((w, i) => (
                <col key={i} style={{ width: `${(w / total) * 100}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <Th key={i} title={c[0]} className="truncate">
                    {c[0]}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <Tr
                  key={i}
                  onClick={r.href ? () => router.push(r.href!) : undefined}
                  className={cx(r.href && "cursor-pointer hover:bg-canvas", r.bg && "bg-brand-soft")}
                >
                  {r.cells.map((x, j) => (
                    <Td
                      key={j}
                      className={cx("align-middle whitespace-normal", compact ? "py-1.5" : "py-2.5", j === 0 && r.edge && "border-l-[3px]", x.cls)}
                      style={{ ...(j === 0 && r.edge ? { borderLeftColor: r.edge } : {}), ...x.style }}
                    >
                      {x.node ?? (
                        <>
                          {j === 0 && r.href ? (
                            <Link href={r.href} onClick={(e) => e.stopPropagation()} className="block text-ink no-underline [overflow-wrap:anywhere] hover:underline">
                              {x.t ?? "—"}
                            </Link>
                          ) : (
                            <span className="block [overflow-wrap:anywhere]">{x.t ?? "—"}</span>
                          )}
                          {x.sub ? <span className="block truncate text-xs text-muted">{x.sub}</span> : null}
                        </>
                      )}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown.length ? (
            <div className="border-t border-divider px-4 py-2.5 text-[13px] text-muted">
              Showing {nf(shown.length)} of {nf(rows.length)}.
            </div>
          ) : null}
        </div>
      ) : (
        <div className="p-5 text-sm text-muted">{emptyLine}</div>
      )}
    </div>
  );
}

export type ListItem = { t: ReactNode; sub?: ReactNode; badge?: ReactNode; action?: ReactNode; strong?: boolean; red?: boolean; edge?: string | null; bg?: string; lead?: ReactNode };

export function ListBlock({ title, sub, items, vault, wide, emptyLine, right }: { title?: ReactNode; sub?: ReactNode; items: ListItem[]; vault?: boolean; wide?: boolean; emptyLine?: string; right?: ReactNode }) {
  return (
    <div className={blockClass(wide)}>
      {title ? <BlockHead title={title} sub={sub} vault={vault} right={right} /> : null}
      {items.map((i, k) => (
        <div
          key={k}
          className={cx("flex items-start gap-3 border-t border-divider px-5 py-3 first:border-t-0", i.bg ? "bg-brand-soft" : "bg-surface", i.edge && "border-l-[3px]")}
          style={i.edge ? { borderLeftColor: i.edge } : undefined}
        >
          {i.lead}
          <span className="min-w-0 flex-1">
            <span className={cx("block text-sm leading-5", i.strong ? "font-semibold" : "font-medium", i.red ? "text-danger" : "text-ink")}>{i.t}</span>
            {i.sub ? <span className="mt-0.5 block text-xs leading-[17px] text-muted">{i.sub}</span> : null}
          </span>
          {i.badge}
          {i.action}
        </div>
      ))}
      {!items.length && emptyLine ? <div className="p-5 text-sm text-muted">{emptyLine}</div> : null}
    </div>
  );
}

/** A headline figure — the shared StatCard's shape. */
export function Stat({ l, v, s, href, red, bar }: { l: string; v: ReactNode; s?: ReactNode; href?: string; red?: boolean; bar?: number }) {
  const body = (
    <>
      <span className="block text-xs font-medium tracking-label text-muted uppercase">{l}</span>
      <span className={cx("mt-2 block text-[32px] leading-9 font-semibold", red ? "text-danger" : "text-ink")}>{v}</span>
      {s ? <span className={cx("mt-1 block text-[13px]", red ? "text-danger" : "text-muted")}>{s}</span> : null}
      {bar != null ? (
        <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-divider">
          <span className="block h-1.5 rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
        </span>
      ) : null}
    </>
  );
  const cls = "block rounded-card border border-line bg-surface p-5 text-left no-underline";
  return href ? (
    <Link href={href} className={cx(cls, "transition-colors duration-100 hover:border-line-strong hover:no-underline")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const STAT_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-2 xl:grid-cols-4", 5: "md:grid-cols-3 xl:grid-cols-5" };
export function StatGrid({ children, n }: { children: ReactNode; n: number }) {
  return <div className={cx("grid grid-cols-1 gap-4", STAT_COLS[Math.min(5, Math.max(1, n))])}>{children}</div>;
}

export function Grid({ children, cols = 1 }: { children: ReactNode; cols?: 1 | 2 }) {
  return <div className={cx("grid grid-cols-1 items-start gap-4", cols === 2 && "lg:grid-cols-2")}>{children}</div>;
}

const ALERT_TONE = { red: "danger", amber: "warn", vault: "neutral", green: "success", grey: "neutral" } as const;
export function Alert({ t, m, tone = "grey", actions }: { t: ReactNode; m: ReactNode; tone?: "red" | "amber" | "vault" | "green" | "grey"; actions?: ReactNode }) {
  return (
    <Callout tone={ALERT_TONE[tone]} className="mb-0">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{t}</span>
        <span className="mt-0.5 block text-[13px] leading-[19px] text-body">{m}</span>
      </span>
      {actions}
    </Callout>
  );
}

export function Bars({ title, sub, bars, note }: { title: ReactNode; sub?: ReactNode; bars: { l: string; v: number; tip?: string; c?: string }[]; note?: ReactNode }) {
  const mx = Math.max(1, ...bars.map((b) => b.v));
  return (
    <Card className="overflow-hidden">
      <BlockHead title={title} sub={sub} />
      <div className="flex flex-col gap-2 px-5 py-4">
          <div className="flex h-[170px] items-end gap-2">
            {bars.map((b, i) => (
              <span key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                <span title={b.tip} className={cx("block w-full max-w-11 rounded-t-[3px]", !b.c && "bg-brand")} style={{ height: Math.max(2, (b.v / mx) * 140), ...(b.c ? { background: b.c } : {}) }} />
                <span className="mt-1.5 text-2xs whitespace-nowrap text-muted">{b.l}</span>
              </span>
            ))}
          </div>
          {note ? <div className="text-xs text-muted">{note}</div> : null}
      </div>
    </Card>
  );
}

export function statusLabel(s: AssetLite["status"]) {
  return STATUS[s]?.label ?? s;
}

export function ShareBar({ t, p, col }: { t: ReactNode; p: number; col?: string }) {
  return (
    <span className="block min-w-0">
      <span className="block">{t}</span>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-divider">
        <span className={cx("block h-1.5 rounded-full", !col && "bg-brand")} style={{ width: `${Math.max(0, Math.min(100, p))}%`, ...(col ? { background: col } : {}) }} />
      </span>
    </span>
  );
}
