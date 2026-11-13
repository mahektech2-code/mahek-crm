"use client";

import type { CSSProperties, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Card, Td, Th, Tr, checkboxClass, cx } from "@/components/ui/primitives";
import { Pill, useDensity, usePager, type BtnKind } from "./kit";
import { LkIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * The generic screen blocks the vault, operations and admin screens are built
 * from — alert, stat strip, table, list, block — drawn in the ERP's v4 design
 * system: the shared `Callout`, `Card`, `Th`/`Td`/`Tr`, `Button` and the v4
 * token classes. Props are the ones the screens were written against.
 * ------------------------------------------------------------------------- */

export type Tone = "red" | "amber" | "vault" | "green" | "grey";
const CALLOUT: Record<Tone, "danger" | "warn" | "neutral" | "success"> = { red: "danger", amber: "warn", vault: "neutral", green: "success", grey: "neutral" };

export function Alert({ t, m, tone = "grey", children }: { t: ReactNode; m?: ReactNode; tone?: Tone; children?: ReactNode }) {
  return (
    <Callout tone={CALLOUT[tone]} className="mb-0 flex-wrap">
      <span className="min-w-[240px] flex-1">
        <span className="block text-sm font-semibold text-ink">{t}</span>
        {m ? <span className="mt-0.5 block text-[13px] leading-[19px] text-body">{m}</span> : null}
      </span>
      {children}
    </Callout>
  );
}

export type StatSpec = { l: string; v: ReactNode; s?: ReactNode; red?: boolean; bar?: number | null };

const STAT_COLS = ["grid-cols-1", "grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4", "grid-cols-5"];

/** The v4 stat strip: StatCard's shape, one card per figure. */
export function Stats({ items }: { items: StatSpec[] }) {
  return (
    <div className={cx("grid gap-4", STAT_COLS[Math.min(5, Math.max(1, items.length))])}>
      {items.map((k) => (
        <div key={k.l} className="rounded-card border border-line bg-surface p-5">
          <span className="block text-xs font-medium tracking-label text-muted uppercase">{k.l}</span>
          <span className={cx("mt-2 block text-[32px] leading-9 font-semibold", k.red ? "text-danger" : "text-ink")}>{k.v}</span>
          {k.s ? <span className="mt-1 block text-[13px] text-muted">{k.s}</span> : null}
          {k.bar != null ? (
            <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-divider">
              <span className="block h-1.5 bg-brand" style={{ width: `${Math.max(0, Math.min(100, k.bar))}%` }} />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A titled card. A vault block carries an ink left edge and the key glyph. */
export function Block({ title, sub, vault, acts, wide, children, style }: { title?: ReactNode; sub?: ReactNode; vault?: boolean; acts?: ReactNode; wide?: boolean; children: ReactNode; style?: CSSProperties }) {
  return (
    <Card className={cx("min-w-0 overflow-hidden", wide && "col-span-full", vault && "shadow-[inset_3px_0_0_var(--color-ink)]")} style={style}>
      {title ? (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-5 py-3.5">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-base font-semibold text-ink">
              {vault ? (
                <span className="flex text-muted">
                  <LkIcon name="key" size={15} />
                </span>
              ) : null}
              {title}
            </span>
            {sub ? <span className="mt-0.5 block text-[13px] font-normal text-muted">{sub}</span> : null}
          </span>
          {acts}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

export function Grid({ cols = 1, children }: { cols?: 1 | 2; children: ReactNode }) {
  return <div className={cx("grid items-start gap-4", cols === 2 ? "grid-cols-2" : "grid-cols-1")}>{children}</div>;
}

/** A cell: a line and an optional muted second line. */
export function Cell({ t, sub, style, className }: { t: ReactNode; sub?: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <span className={cx("block min-w-0 leading-[19px] [overflow-wrap:anywhere]", className)} style={style}>
      <span className="block truncate">{t == null || t === "" ? "—" : t}</span>
      {sub ? <span className="block truncate text-xs font-normal text-muted">{sub}</span> : null}
    </span>
  );
}

export function BarCell({ t, pct, col }: { t: ReactNode; pct: number; col?: string }) {
  return (
    <span className="block min-w-0">
      <span className="block">{t}</span>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-divider">
        <span className={cx("block h-1.5", col ? undefined : "bg-brand")} style={{ width: `${Math.max(0, Math.min(100, pct))}%`, ...(col ? { background: col } : {}) }} />
      </span>
    </span>
  );
}

export type GRow = { key: string; cells: ReactNode[]; href?: string; onClick?: () => void; edge?: string | null; bg?: string | null };

/** The relative width of a column spec ("minmax(200px,2fr)", "120px", "1fr") as a weight. */
function weight(t: string): number {
  const m = /^minmax\((\d+)px,\s*([\d.]+)fr\)$/.exec(t);
  if (m) return Math.max(+m[1], +m[2] * 130);
  const p = /^(\d+)px$/.exec(t);
  if (p) return +p[1];
  const f = /^([\d.]+)fr$/.exec(t);
  if (f) return +f[1] * 130;
  return 130;
}

/** The shared table — Th/Td/Tr in a scrolling box, the row's edge colour where one is given, paging past 25. */
export function GTable({ cols, rows, emptyLine = "Nothing to show.", page = true }: { cols: [string, string][]; rows: GRow[]; vault?: boolean; emptyLine?: string; page?: boolean }) {
  const router = useRouter();
  const compact = useDensity() === "compact";
  const P = usePager(rows.length);
  const total = cols.reduce((s, c) => s + weight(c[1]), 0) || 1;
  const shown = page && rows.length > 25 ? P.slice(rows) : rows;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            {cols.map(([h, w], i) => (
              <col key={i + h} style={{ width: `${((weight(w) / total) * 100).toFixed(2)}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {cols.map(([h], i) => (
                <Th key={i} title={h} className="truncate">
                  {h}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const click = r.onClick ?? (r.href ? () => router.push(r.href!) : undefined);
              return (
                <Tr
                  key={r.key}
                  onClick={click}
                  className={cx(click && "cursor-pointer hover:bg-canvas")}
                  style={{ ...(r.bg ? { background: r.bg } : {}), ...(r.edge ? { boxShadow: `inset 3px 0 0 ${r.edge}` } : {}) }}
                >
                  {r.cells.map((c, k) => (
                    <Td key={k} className={cx("whitespace-normal align-middle", compact ? "py-1.5" : "py-2.5")}>
                      {c}
                    </Td>
                  ))}
                </Tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rows.length ? <div className="p-5 text-sm text-muted">{emptyLine}</div> : null}
      {page && rows.length > 25 ? P.footer : null}
    </div>
  );
}

export type LItem = { key: string; t: ReactNode; sub?: ReactNode; check?: boolean; on?: boolean; flip?: () => void; ro?: boolean; badge?: ReactNode; btn?: string; btnKind?: BtnKind; off?: boolean; why?: string; run?: () => void; red?: boolean; strong?: boolean; edge?: string; bg?: string; extra?: ReactNode };

const LIST_VARIANT: Record<BtnKind, "primary" | "secondary" | "danger" | "ghost"> = { p: "primary", s: "secondary", d: "danger", v: "primary", g: "ghost" };

export function LList({ items, empty }: { items: LItem[]; empty?: string }) {
  return (
    <div>
      {items.map((i) => (
        <div
          key={i.key}
          className="flex flex-wrap items-start gap-3 border-t border-divider bg-surface px-5 py-3 first:border-t-0"
          style={{ ...(i.bg ? { background: i.bg } : {}), ...(i.edge ? { boxShadow: `inset 3px 0 0 ${i.edge}` } : {}) }}
        >
          {i.check ? <input type="checkbox" checked={!!i.on} onChange={() => i.flip?.()} disabled={i.ro} className={cx(checkboxClass, "mt-0.5")} /> : null}
          <span className="min-w-[180px] flex-1">
            <span className={cx("block text-sm leading-5", i.strong ? "font-semibold" : "font-medium", i.red ? "text-danger" : "text-ink")}>{i.t}</span>
            {i.sub ? <span className="mt-0.5 block text-xs leading-[17px] text-muted">{i.sub}</span> : null}
            {i.extra}
          </span>
          {i.badge}
          {i.btn ? (
            <Button size="sm" variant={LIST_VARIANT[i.btnKind ?? "s"]} disabled={i.off} title={i.off ? i.why : undefined} onClick={i.off ? undefined : i.run}>
              {i.btn}
            </Button>
          ) : null}
        </div>
      ))}
      {!items.length && empty ? <div className="px-5 py-3.5 text-[13px] text-muted">{empty}</div> : null}
    </div>
  );
}

export function Yes({ on, yes = "On", no = "Off", noTone = "red" }: { on: boolean; yes?: string; no?: string; noTone?: "red" | "amber" }) {
  return on ? <Pill label={yes} tone="success" /> : <Pill label={no} tone={noTone === "red" ? "danger" : "warn"} />;
}

/** Said plainly on every vault screen when the deployment cannot encrypt. */
export function NoVaultKey() {
  return (
    <Alert
      tone="red"
      t="The vault has no key on this deployment"
      m="Nothing can be stored or revealed until the server has a vault key (LOCKER_KEK, or the app signing secret). Nothing is ever stored in the clear instead."
    />
  );
}

/** "12 Oct 2026" from an ISO instant, in IST. */
export { when } from "@/lib/locker/style";
