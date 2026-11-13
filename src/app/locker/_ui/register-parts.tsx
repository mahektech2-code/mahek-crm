"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { CRIT, STATUS, daysColour, daysLabel } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { C, LBL, StatusPill, fd, nf, useDensity } from "./kit";

/* ---------------------------------------------------------------------------
 * The register's own parts, drawn as the design draws them: the attention row
 * (dashboard, my work), the generic blocks its "gen" screens are built from —
 * a table, a list, a stat tile, bars and an alert — all link-driven so a
 * server page can render them without handing a function across.
 * ------------------------------------------------------------------------- */

export function countdown(a: AssetLite): { cd: string; date: string } {
  if (a.model === "term_contract" && a.noticeDays) {
    return { cd: a.actionIn == null ? "No expiry" : a.actionIn >= 0 ? `${nf(a.actionIn)} days to notice` : "Notice passed", date: `Notice by ${fd(a.actionDate)}` };
  }
  return { cd: daysLabel(a.d), date: a.endDate ? `${a.model === "subscription" ? "Renews" : a.d != null && a.d < 0 ? "Expired" : "Expires"} ${fd(a.endDate)}` : "No expiry" };
}

/** The design's attention row: title + status, meta, optional consequence, the countdown on the right. */
export function AttentionRow({ a, conseq }: { a: AssetLite; conseq?: boolean }) {
  const tight = useDensity() === "compact";
  const { cd, date } = countdown(a);
  const show = conseq && a.crit === 4;
  return (
    <Link
      href={`/locker/assets/${a.id}`}
      className="lk-row"
      style={{ display: "flex", alignItems: "flex-start", gap: 20, width: "100%", padding: tight ? "10px 20px" : "14px 20px", borderTop: `1px solid ${C.line3}`, background: "#FFFFFF", boxShadow: `inset 3px 0 0 ${CRIT[a.crit].edge}`, textAlign: "left", textDecoration: "none" }}
    >
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: C.ink }}>{a.title}</span>
          <StatusPill status={a.status} />
        </span>
        <span style={{ display: "block", fontSize: 13, color: C.muted, marginTop: 2 }}>
          {[a.typeName, a.siteName ?? a.entityName ?? "Company-wide", a.ownerName ? `Owner ${a.ownerName}` : "No owner"].join(" · ")}
        </span>
        {show ? <span style={{ display: "block", fontSize: 13, lineHeight: "19px", color: C.body, marginTop: 6, textWrap: "pretty" }}>{a.consequence || "If this runs out, the work it allows must stop."}</span> : null}
      </span>
      <span style={{ textAlign: "right", flex: "none", minWidth: 120 }}>
        <span style={{ display: "block", fontSize: 22, lineHeight: "26px", fontWeight: 600, color: a.d != null && a.d < 0 ? daysColour(a.d, a.status) : C.ink }}>{cd}</span>
        <span style={{ display: "block", fontSize: 12, color: C.muted }}>{date}</span>
      </span>
    </Link>
  );
}

/* ---------------------------------------------------------------- blocks */

export const blockStyle = (vault?: boolean, wide?: boolean): CSSProperties => ({
  background: "#FFFFFF",
  border: `1px solid ${vault ? C.v100 : C.line}`,
  borderRadius: 6,
  overflow: "hidden",
  boxShadow: vault ? `inset 3px 0 0 ${C.v700}` : "none",
  gridColumn: wide ? "1 / -1" : "auto",
  minWidth: 0,
});

export function BlockHead({ title, sub, right, vault }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; vault?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", background: vault ? C.v50 : "#FFFFFF", borderBottom: `1px solid ${vault ? C.v100 : C.line2}`, color: vault ? C.v900 : C.ink }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{title}</span>
        {sub ? <span style={{ display: "block", fontSize: 12, fontWeight: 400, opacity: 0.8, marginTop: 2 }}>{sub}</span> : null}
      </span>
      {right}
    </div>
  );
}

export type Cell = { t?: ReactNode; sub?: ReactNode; style?: CSSProperties; node?: ReactNode };
export type GenRow = { href?: string; edge?: string | null; bg?: string; cells: Cell[] };

/** px widths become proportional so the table never scrolls sideways — the design's own `fluid`. */
function fluid(t: string): string {
  const m = /^minmax\((\d+)px,\s*([\d.]+)fr\)$/.exec(t);
  if (m) return `minmax(0,${Math.max(+m[1], +m[2] * 130)}fr)`;
  const p = /^(\d+)px$/.exec(t);
  if (p) return `minmax(0,${p[1]}fr)`;
  return t;
}

export function GenTable({ title, sub, cols, rows, emptyLine = "Nothing to show.", vault, wide, right, pageSize = 25 }: { title?: ReactNode; sub?: ReactNode; cols: [string, string][]; rows: GenRow[]; emptyLine?: string; vault?: boolean; wide?: boolean; right?: ReactNode; pageSize?: number }) {
  const compact = useDensity() === "compact";
  const tpl = cols.map((c) => fluid(c[1])).join(" ");
  const shown = rows.slice(0, pageSize * 8);
  return (
    <div style={blockStyle(vault, wide)}>
      {title ? <BlockHead title={title} sub={sub} vault={vault} right={right} /> : null}
      {rows.length ? (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, padding: "0 20px", height: 34, alignItems: "center", background: vault ? C.v50 : C.canvas, borderBottom: `1px solid ${vault ? C.v100 : C.line2}`, fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: vault ? C.v500 : C.muted }}>
            {cols.map((c, i) => (
              <span key={i} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c[0]}>
                {c[0]}
              </span>
            ))}
          </div>
          {shown.map((r, i) => {
            const style: CSSProperties = {
              display: "grid",
              gridTemplateColumns: tpl,
              gap: 12,
              padding: compact ? "6px 20px" : "10px 20px",
              minHeight: compact ? 36 : 44,
              borderTop: `1px solid ${C.line3}`,
              alignItems: "center",
              fontSize: 14,
              color: C.body,
              background: r.bg || (i % 2 ? C.canvas : "#FFFFFF"),
              boxShadow: r.edge ? `inset 3px 0 0 ${r.edge}` : "none",
              textDecoration: "none",
            };
            const cells = r.cells.map((x, j) => (
              <span key={j} style={{ minWidth: 0, overflowWrap: "anywhere", lineHeight: "19px", ...x.style }}>
                {x.node ?? (
                  <>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{x.t ?? "—"}</span>
                    {x.sub ? <span style={{ display: "block", fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis" }}>{x.sub}</span> : null}
                  </>
                )}
              </span>
            ));
            return r.href ? (
              <Link key={i} href={r.href} className="lk-row" style={{ ...style, cursor: "pointer" }}>
                {cells}
              </Link>
            ) : (
              <div key={i} style={style}>
                {cells}
              </div>
            );
          })}
          {rows.length > shown.length ? <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.line2}`, fontSize: 13, color: C.muted }}>Showing {nf(shown.length)} of {nf(rows.length)}.</div> : null}
        </div>
      ) : (
        <div style={{ padding: 20, fontSize: 14, color: C.muted }}>{emptyLine}</div>
      )}
    </div>
  );
}

export type ListItem = { t: ReactNode; sub?: ReactNode; badge?: ReactNode; action?: ReactNode; strong?: boolean; red?: boolean; edge?: string | null; bg?: string; lead?: ReactNode };

export function ListBlock({ title, sub, items, vault, wide, emptyLine, right }: { title?: ReactNode; sub?: ReactNode; items: ListItem[]; vault?: boolean; wide?: boolean; emptyLine?: string; right?: ReactNode }) {
  return (
    <div style={blockStyle(vault, wide)}>
      {title ? <BlockHead title={title} sub={sub} vault={vault} right={right} /> : null}
      {items.map((i, k) => (
        <div key={k} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 20px", borderTop: `1px solid ${C.line3}`, background: i.bg || "#FFFFFF", boxShadow: i.edge ? `inset 3px 0 0 ${i.edge}` : "none" }}>
          {i.lead}
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 14, fontWeight: i.strong ? 600 : 500, color: i.red ? C.red : C.ink, lineHeight: "20px" }}>{i.t}</span>
            {i.sub ? <span style={{ display: "block", fontSize: 12, lineHeight: "17px", color: C.muted, marginTop: 2 }}>{i.sub}</span> : null}
          </span>
          {i.badge}
          {i.action}
        </div>
      ))}
      {!items.length && emptyLine ? <div style={{ padding: 20, fontSize: 14, color: C.muted }}>{emptyLine}</div> : null}
    </div>
  );
}

export function Stat({ l, v, s, href, red, bar }: { l: string; v: ReactNode; s?: ReactNode; href?: string; red?: boolean; bar?: number }) {
  const body = (
    <>
      <span style={{ ...LBL, display: "block" }}>{l}</span>
      <span style={{ display: "block", fontSize: 32, lineHeight: "36px", fontWeight: 600, color: red ? C.red : C.ink, marginTop: 6 }}>{v}</span>
      {s ? <span style={{ display: "block", fontSize: 12, color: red ? C.redInk : C.muted, marginTop: 2 }}>{s}</span> : null}
      {bar != null ? (
        <span style={{ display: "block", height: 6, borderRadius: 3, background: C.line2, marginTop: 10, overflow: "hidden" }}>
          <span style={{ display: "block", height: 6, width: `${Math.max(0, Math.min(100, bar))}%`, background: C.brand }} />
        </span>
      ) : null}
    </>
  );
  const st: CSSProperties = { background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, padding: "16px 20px", textAlign: "left", textDecoration: "none", display: "block" };
  return href ? (
    <Link href={href} className="lk-card-hover" style={st}>
      {body}
    </Link>
  ) : (
    <div style={st}>{body}</div>
  );
}

export function StatGrid({ children, n }: { children: ReactNode; n: number }) {
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(5, Math.max(1, n))},minmax(0,1fr))`, gap: 16 }}>{children}</div>;
}

export function Grid({ children, cols = 1 }: { children: ReactNode; cols?: 1 | 2 }) {
  return <div style={{ display: "grid", gridTemplateColumns: cols === 2 ? "repeat(2,minmax(0,1fr))" : "minmax(0,1fr)", gap: 16, alignItems: "start" }}>{children}</div>;
}

export function Alert({ t, m, tone = "grey", actions }: { t: ReactNode; m: ReactNode; tone?: "red" | "amber" | "vault" | "green" | "grey"; actions?: ReactNode }) {
  const T = { red: ["#FCECEC", "#8E1F1F", "#F6CFCF"], amber: ["#FDF6E7", "#8A5C05", "#F9E9C4"], vault: [C.v50, C.v900, C.v100], green: ["#E9F5EE", "#1D7A45", "#C7E6D3"], grey: ["#F7F8FA", "#3D4453", "#DDE1E8"] }[tone];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderRadius: 6, background: T[0], color: T[1], border: `1px solid ${T[2]}` }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{t}</span>
        <span style={{ display: "block", fontSize: 13, lineHeight: "19px", marginTop: 2 }}>{m}</span>
      </span>
      {actions}
    </div>
  );
}

export function Bars({ title, sub, bars, note }: { title: ReactNode; sub?: ReactNode; bars: { l: string; v: number; tip?: string; c?: string }[]; note?: ReactNode }) {
  const mx = Math.max(1, ...bars.map((b) => b.v));
  return (
    <div style={blockStyle()}>
      <BlockHead title={title} sub={sub} />
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 170 }}>
          {bars.map((b, i) => (
            <span key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", minWidth: 0 }}>
              <span title={b.tip} style={{ display: "block", width: "100%", maxWidth: 44, height: Math.max(2, (b.v / mx) * 140), background: b.c || C.brand, borderRadius: "3px 3px 0 0" }} />
              <span style={{ fontSize: 11, color: C.muted, marginTop: 6, whiteSpace: "nowrap" }}>{b.l}</span>
            </span>
          ))}
        </div>
        {note ? <div style={{ fontSize: 12, color: C.muted }}>{note}</div> : null}
      </div>
    </div>
  );
}

export function statusLabel(s: AssetLite["status"]) {
  return STATUS[s]?.label ?? s;
}

export function ShareBar({ t, p, col }: { t: ReactNode; p: number; col?: string }) {
  return (
    <span style={{ minWidth: 0, display: "block" }}>
      <span style={{ display: "block" }}>{t}</span>
      <span style={{ display: "block", height: 6, borderRadius: 3, background: C.line2, marginTop: 4, overflow: "hidden" }}>
        <span style={{ display: "block", height: 6, width: `${Math.max(0, Math.min(100, p))}%`, background: col || C.brand }} />
      </span>
    </span>
  );
}
