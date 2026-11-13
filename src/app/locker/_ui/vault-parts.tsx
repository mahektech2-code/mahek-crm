"use client";

import type { CSSProperties, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { C, LBL, btnStyle, BTN_OFF, Pill, useDensity, usePager, type BtnKind } from "./kit";

/* ---------------------------------------------------------------------------
 * The design's generic screen blocks — alert, stat strip, table, list, block —
 * used by the vault, operations and admin screens. Same colours and spacing
 * as `blk`, `table`, `list`, `stat` and `alert` in the design.
 * ------------------------------------------------------------------------- */

const TONE = {
  red: ["#FCECEC", "#8E1F1F", "#F6CFCF"],
  amber: ["#FDF6E7", "#8A5C05", "#F9E9C4"],
  vault: [C.v50, C.v900, C.v100],
  green: ["#E9F5EE", "#1D7A45", "#C7E6D3"],
  grey: ["#F7F8FA", "#3D4453", "#DDE1E8"],
} as const;
export type Tone = keyof typeof TONE;

export function Alert({ t, m, tone = "grey", children }: { t: ReactNode; m?: ReactNode; tone?: Tone; children?: ReactNode }) {
  const T = TONE[tone];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderRadius: 6, background: T[0], color: T[1], border: `1px solid ${T[2]}`, flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 240 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{t}</span>
        {m ? <span style={{ display: "block", fontSize: 13, lineHeight: "19px", marginTop: 2 }}>{m}</span> : null}
      </span>
      {children}
    </div>
  );
}

export type StatSpec = { l: string; v: ReactNode; s?: ReactNode; red?: boolean; bar?: number | null };

export function Stats({ items }: { items: StatSpec[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(5, Math.max(1, items.length))},minmax(0,1fr))`, gap: 16 }}>
      {items.map((k) => (
        <div key={k.l} style={{ background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, padding: "16px 20px" }}>
          <span style={{ display: "block", ...LBL }}>{k.l}</span>
          <span style={{ display: "block", fontSize: 32, lineHeight: "36px", fontWeight: 600, color: k.red ? C.red : C.ink, marginTop: 6 }}>{k.v}</span>
          {k.s ? <span style={{ display: "block", fontSize: 12, color: C.muted, marginTop: 2 }}>{k.s}</span> : null}
          {k.bar != null ? (
            <span style={{ display: "block", height: 6, borderRadius: 3, background: C.line2, marginTop: 10, overflow: "hidden" }}>
              <span style={{ display: "block", height: 6, width: `${Math.max(0, Math.min(100, k.bar))}%`, background: C.brand }} />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Block({ title, sub, vault, acts, wide, children, style }: { title?: ReactNode; sub?: ReactNode; vault?: boolean; acts?: ReactNode; wide?: boolean; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: "#FFFFFF", border: `1px solid ${vault ? C.v100 : C.line}`, borderRadius: 6, overflow: "hidden", boxShadow: vault ? `inset 3px 0 0 ${C.v700}` : "none", gridColumn: wide ? "1 / -1" : "auto", minWidth: 0, ...style }}>
      {title ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", background: vault ? C.v50 : "#FFFFFF", borderBottom: `1px solid ${vault ? C.v100 : C.line2}`, color: vault ? C.v900 : C.ink, flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{title}</span>
            {sub ? <span style={{ display: "block", fontSize: 12, fontWeight: 400, opacity: 0.8, marginTop: 2 }}>{sub}</span> : null}
          </span>
          {acts}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Grid({ cols = 1, children }: { cols?: 1 | 2; children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: cols === 2 ? "repeat(2,minmax(0,1fr))" : "minmax(0,1fr)", gap: 16, alignItems: "start" }}>{children}</div>;
}

/** A cell: a line and an optional muted second line. */
export function Cell({ t, sub, style }: { t: ReactNode; sub?: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ minWidth: 0, overflowWrap: "anywhere", lineHeight: "19px", ...style }}>
      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{t == null || t === "" ? "—" : t}</span>
      {sub ? <span style={{ display: "block", fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", fontWeight: 400 }}>{sub}</span> : null}
    </span>
  );
}

export function BarCell({ t, pct, col }: { t: ReactNode; pct: number; col?: string }) {
  return (
    <span style={{ minWidth: 0 }}>
      <span style={{ display: "block" }}>{t}</span>
      <span style={{ display: "block", height: 6, borderRadius: 3, background: C.line2, marginTop: 4, overflow: "hidden" }}>
        <span style={{ display: "block", height: 6, width: `${Math.max(0, Math.min(100, pct))}%`, background: col ?? C.brand }} />
      </span>
    </span>
  );
}

export type GRow = { key: string; cells: ReactNode[]; href?: string; onClick?: () => void; edge?: string | null; bg?: string | null };

/** The design's table block: fluid grid columns, striped rows, an edge colour, paging past 25. */
export function GTable({ cols, rows, vault, emptyLine = "Nothing to show.", page = true }: { cols: [string, string][]; rows: GRow[]; vault?: boolean; emptyLine?: string; page?: boolean }) {
  const router = useRouter();
  const compact = useDensity() === "compact";
  const P = usePager(rows.length);
  const fluid = (t: string) => {
    const m = /^minmax\((\d+)px,\s*([\d.]+)fr\)$/.exec(t);
    if (m) return `minmax(0,${Math.max(+m[1], +m[2] * 130)}fr)`;
    const p = /^(\d+)px$/.exec(t);
    if (p) return `minmax(0,${p[1]}fr)`;
    return t;
  };
  const tpl = cols.map((c) => fluid(c[1])).join(" ");
  const shown = page && rows.length > 25 ? P.slice(rows) : rows;
  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, padding: "0 20px", height: 34, alignItems: "center", background: vault ? C.v50 : C.canvas, borderBottom: `1px solid ${vault ? C.v100 : C.line2}`, fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: vault ? C.v500 : C.muted }}>
            {cols.map(([h], i) => (
              <span key={i} title={h} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h}
              </span>
            ))}
          </div>
          {shown.map((r, i) => {
            const click = r.onClick ?? (r.href ? () => router.push(r.href!) : undefined);
            return (
              <div
                key={r.key}
                onClick={click}
                className={click ? "lk-row" : undefined}
                style={{
                  display: "grid",
                  gridTemplateColumns: tpl,
                  gap: 12,
                  padding: compact ? "6px 20px" : "10px 20px",
                  minHeight: compact ? 36 : 44,
                  borderTop: `1px solid ${C.line3}`,
                  alignItems: "center",
                  fontSize: 14,
                  color: C.body,
                  background: r.bg ?? (i % 2 ? C.canvas : "#FFFFFF"),
                  boxShadow: r.edge ? `inset 3px 0 0 ${r.edge}` : "none",
                  cursor: click ? "pointer" : "default",
                }}
              >
                {r.cells.map((c, k) => (
                  <span key={k} style={{ minWidth: 0 }}>
                    {c}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {!rows.length ? <div style={{ padding: 20, fontSize: 14, color: C.muted }}>{emptyLine}</div> : null}
      {page && rows.length > 25 ? P.footer : null}
    </div>
  );
}

export type LItem = { key: string; t: ReactNode; sub?: ReactNode; check?: boolean; on?: boolean; flip?: () => void; ro?: boolean; badge?: ReactNode; btn?: string; btnKind?: BtnKind; off?: boolean; why?: string; run?: () => void; red?: boolean; strong?: boolean; edge?: string; bg?: string; extra?: ReactNode };

export function LList({ items, empty }: { items: LItem[]; empty?: string }) {
  return (
    <div>
      {items.map((i) => (
        <div key={i.key} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 20px", borderTop: `1px solid ${C.line3}`, background: i.bg ?? "#FFFFFF", boxShadow: i.edge ? `inset 3px 0 0 ${i.edge}` : "none", flexWrap: "wrap" }}>
          {i.check ? <input type="checkbox" checked={!!i.on} onChange={() => i.flip?.()} disabled={i.ro} style={{ width: 18, height: 18, accentColor: C.brand, flex: "none", marginTop: 1 }} /> : null}
          <span style={{ flex: 1, minWidth: 180 }}>
            <span style={{ display: "block", fontSize: 14, fontWeight: i.strong ? 600 : 500, color: i.red ? C.red : C.ink, lineHeight: "20px" }}>{i.t}</span>
            {i.sub ? <span style={{ display: "block", fontSize: 12, lineHeight: "17px", color: C.muted, marginTop: 2 }}>{i.sub}</span> : null}
            {i.extra}
          </span>
          {i.badge}
          {i.btn ? (
            <button type="button" onClick={i.off ? undefined : i.run} title={i.off ? i.why : undefined} style={i.off ? { ...BTN_OFF, height: 30, fontSize: 13, padding: "0 10px" } : btnStyle(i.btnKind ?? "s", true)}>
              {i.btn}
            </button>
          ) : null}
        </div>
      ))}
      {!items.length && empty ? <div style={{ padding: "14px 20px", fontSize: 13, color: C.muted }}>{empty}</div> : null}
    </div>
  );
}

export function Yes({ on, yes = "On", no = "Off", noTone = "red" }: { on: boolean; yes?: string; no?: string; noTone?: "red" | "amber" }) {
  return on ? <Pill label={yes} bg="#E9F5EE" fg="#1D7A45" /> : <Pill label={no} bg={noTone === "red" ? "#FCECEC" : "#FDF6E7"} fg={noTone === "red" ? "#B3261E" : "#8A5C05"} />;
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
