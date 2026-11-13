"use client";

import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CRIT, STATUS, TIER, type Status, type Tier } from "@/lib/locker/engine";
import { LkIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * THE LOCKER'S PARTS, drawn exactly as the design draws them — its colours,
 * sizes and spacing as inline styles, because the design was written that way
 * and a translation into utility classes is where "same to same" drifts.
 * Every screen is built from these; a screen that writes its own pill or its
 * own button is a screen that will stop matching.
 * ------------------------------------------------------------------------- */

import { C, LBL, MONO, btnStyle, type BtnKind } from "@/lib/locker/style";
/* The pure values live in lib/locker/style.ts so SERVER pages can use them
   too — a value exported from this client module is only a reference there. */
export { C, LBL, MONO, btnStyle, type BtnKind };

export const BTN_OFF: CSSProperties = { ...btnStyle("s"), color: C.faint, background: C.soft, border: `1px solid ${C.line2}`, cursor: "not-allowed" };

export function Btn({
  kind = "s",
  small,
  disabled,
  why,
  onClick,
  type = "button",
  children,
  style,
}: {
  kind?: BtnKind;
  small?: boolean;
  disabled?: boolean;
  /** Why it is disabled — every disabled control here says. */
  why?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  children: ReactNode;
  style?: CSSProperties;
}) {
  const base = disabled ? { ...BTN_OFF, ...(small ? { height: 30, padding: "0 10px", fontSize: 13 } : {}) } : btnStyle(kind, small);
  return (
    <button type={type} onClick={disabled ? undefined : onClick} title={disabled ? why : undefined} aria-disabled={disabled || undefined} style={{ ...base, ...style }}>
      {children}
    </button>
  );
}

export function Pill({ label, bg, fg, style }: { label: ReactNode; bg: string; fg: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 20,
        padding: "0 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 500,
        whiteSpace: "nowrap",
        background: bg,
        color: fg,
        ...style,
      }}
    >
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  const t = STATUS[status] ?? STATUS.active;
  return <Pill label={(t.glyph ?? "") + t.label} bg={t.bg} fg={t.fg} style={t.ring ? { boxShadow: `inset 0 0 0 1px ${t.ring}` } : undefined} />;
}

export function CritPill({ crit }: { crit: number }) {
  const t = CRIT[crit] ?? CRIT[2];
  return <Pill label={t.label} bg={t.bg} fg={t.fg} />;
}

export function TierPill({ tier }: { tier: Tier }) {
  const t = TIER[tier] ?? TIER.standard;
  return <Pill label={t.label.toUpperCase()} bg={t.bg} fg={t.fg} style={{ letterSpacing: "0.04em" }} />;
}

export function Tag({ label, tone }: { label: string; tone: "red" | "amber" | "blue" | "green" | "grey" | "violet" }) {
  const m = {
    red: [C.redSoft, C.red],
    amber: [C.amberSoft, C.amber],
    blue: [C.blueSoft, C.blue],
    green: [C.greenSoft, C.green],
    grey: [C.soft, C.muted],
    violet: [C.v50, C.v700],
  }[tone];
  return <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 10, background: m[0], color: m[1], whiteSpace: "nowrap" }}>{label}</span>;
}

export const card: CSSProperties = { background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" };
export const vaultCard: CSSProperties = { background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden" };
export const vaultEdge: CSSProperties = { ...vaultCard, boxShadow: `inset 3px 0 0 ${C.v700}` };

export function Card({ children, style, vault }: { children: ReactNode; style?: CSSProperties; vault?: boolean }) {
  return <div style={{ ...(vault ? vaultCard : card), ...style }}>{children}</div>;
}

/** A card's own heading bar — plain, or the vault's violet. */
export function CardHead({ title, sub, right, vault }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; vault?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 20px",
        background: vault ? C.v50 : "#FFFFFF",
        borderBottom: `1px solid ${vault ? C.v100 : C.line2}`,
        color: vault ? C.v900 : C.ink,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{title}</span>
        {sub ? <span style={{ display: "block", fontSize: 12, fontWeight: 400, color: vault ? C.v500 : C.muted, marginTop: 2 }}>{sub}</span> : null}
      </span>
      {right}
    </div>
  );
}

/** The page head every screen opens with: crumb, title, one line, actions on the right. */
export function PageHead({ crumb, title, sub, actions, vault }: { crumb: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode; vault?: boolean }) {
  return (
    <div style={{ padding: "20px 24px 16px 24px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0, flex: "1 1 420px" }}>
        <div style={{ ...LBL, ...(vault ? { color: C.v500 } : {}) }}>{crumb}</div>
        <div style={{ fontSize: 28, lineHeight: "34px", fontWeight: 600, color: C.ink, marginTop: 2 }}>{title}</div>
        {sub ? <div style={{ fontSize: 14, color: C.muted, marginTop: 4, maxWidth: 820, textWrap: "pretty" }}>{sub}</div> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{actions}</div> : null}
    </div>
  );
}

export function Body({ children, gap = 12, pad = "0 24px 40px 24px" }: { children: ReactNode; gap?: number; pad?: string }) {
  return <div style={{ padding: pad, display: "flex", flexDirection: "column", gap }}>{children}</div>;
}

/** A row of underlined tabs. */
export function Tabs<K extends string>({ tabs, value, onPick }: { tabs: { key: K; label: ReactNode; n?: string; red?: boolean }[]; value: K; onPick: (k: K) => void }) {
  return (
    <div style={{ display: "flex", gap: 24, borderBottom: `1px solid ${C.line}`, overflowX: "auto" }}>
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onPick(t.key)}
            style={{
              height: 40,
              padding: 0,
              border: "none",
              background: "transparent",
              fontSize: 14,
              fontWeight: on ? 600 : 400,
              color: t.red ? C.red : on ? C.ink : C.body,
              boxShadow: on ? `inset 0 -2px 0 ${C.brand}` : "none",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t.label} {t.n != null ? <span style={{ color: C.muted, fontWeight: 400 }}>{t.n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A small segmented control: Table / Cards, Month / Year, Comfortable / Compact. */
export function Segmented<K extends string>({ opts, value, onPick, dark }: { opts: { key: K; label: string }[]; value: K; onPick: (k: K) => void; dark?: boolean }) {
  return (
    <span style={{ display: "inline-flex", gap: 2, padding: 3, border: `1px solid ${C.line}`, borderRadius: 6, background: "#FFFFFF", flex: "none" }}>
      {opts.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onPick(o.key)}
            style={{
              height: 28,
              padding: dark ? "0 10px" : "0 12px",
              border: "none",
              borderRadius: 4,
              background: on ? (dark ? C.ink : C.brand) : "transparent",
              color: on ? "#FFFFFF" : C.body,
              fontSize: dark ? 12 : 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

/** A filter chip that toggles. */
export function Chip({ label, on, onFlip, vault }: { label: ReactNode; on: boolean; onFlip: () => void; vault?: boolean }) {
  const accent = vault ? C.v700 : C.brand;
  return (
    <button
      type="button"
      onClick={onFlip}
      style={{
        height: 30,
        padding: "0 12px",
        borderRadius: 15,
        border: `1px solid ${on ? accent : "#C2C8D2"}`,
        background: on ? (vault ? C.v50 : C.brandSoft) : "#FFFFFF",
        color: on ? (vault ? C.v900 : C.brandInk) : C.body,
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

export function SearchBox({ value, onChange, placeholder, width = 240 }: { value: string; onChange: (v: string) => void; placeholder: string; width?: number }) {
  return (
    <span style={{ position: "relative", width, flex: "none" }}>
      <span style={{ position: "absolute", left: 10, top: 9, color: C.muted, display: "flex" }}>
        <LkIcon name="search" />
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width: "100%", height: 34, padding: "0 10px 0 32px", border: "1px solid #C2C8D2", borderRadius: 4, background: "#FFFFFF", fontSize: 14 }}
      />
    </span>
  );
}

export type PickOpt = { v: string; l: string; m?: string | number };

/**
 * THE FILTER PICKER: a labelled button that opens a searchable list. Shows 60
 * at a time and says so, because a list of 140 dealers is a search box's job.
 */
export function Picker({ k, label, value, options, onPick, ph = "Search" }: { k: string; label: string; value: string; options: PickOpt[]; onPick: (v: string) => void; ph?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  const needle = q.trim().toLowerCase();
  const hits = needle ? options.filter((o) => `${o.l} ${o.m ?? ""}`.toLowerCase().includes(needle)) : options;
  const shown = hits.slice(0, 60);
  return (
    <span style={{ position: "relative", flex: "none" }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setQ("");
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: 34,
          padding: "0 10px",
          border: `1px solid ${open || value ? C.brand : "#C2C8D2"}`,
          borderRadius: 4,
          background: "#FFFFFF",
          fontSize: 14,
          fontWeight: 500,
          color: C.ink,
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted }}>{k}</span>
        <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ color: C.faint }}>▾</span>
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: 40,
            left: 0,
            zIndex: 30,
            width: 340,
            background: "#FFFFFF",
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(26,30,40,0.12)",
            overflow: "hidden",
            animation: "lk-pop 150ms cubic-bezier(0.2,0,0.2,1)",
          }}
        >
          <div style={{ padding: 8, borderBottom: `1px solid ${C.line2}` }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={ph} style={{ width: "100%", height: 34, padding: "0 10px", border: "1px solid #C2C8D2", borderRadius: 4, fontSize: 14 }} />
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {shown.map((o) => (
              <button
                key={o.v + o.l}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(o.v);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "8px 12px",
                  border: "none",
                  borderTop: `1px solid ${C.soft}`,
                  background: o.v === value ? C.brandSoft : "#FFFFFF",
                  color: o.v === value ? C.brandInk : C.ink,
                  fontSize: 14,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.l}</span>
                <span style={{ fontSize: 12, color: C.muted, flex: "none" }}>{o.m ?? ""}</span>
              </button>
            ))}
            {!hits.length ? <div style={{ padding: 12, fontSize: 13, color: C.muted }}>Nothing matches “{q}”.</div> : null}
          </div>
          {hits.length > shown.length ? (
            <div style={{ padding: "8px 12px", borderTop: `1px solid ${C.line2}`, fontSize: 12, color: C.muted }}>
              Showing 60 of {hits.length.toLocaleString("en-IN")} — keep typing to narrow it down
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/** Paging for a long table, in the design's footer. */
export function usePager(total: number, initialSize = 25) {
  const [size, setSize] = useState(initialSize);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, pages - 1);
  return {
    slice: <T,>(arr: T[]) => arr.slice(p * size, p * size + size),
    reset: () => setPage(0),
    footer: (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: `1px solid ${C.line2}`, fontSize: 13, color: C.muted, background: "#FFFFFF" }}>
        <span>{total ? `Showing ${(p * size + 1).toLocaleString("en-IN")}–${Math.min(total, p * size + size).toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")}` : "Nothing to show"}</span>
        <span style={{ flex: 1 }} />
        <select
          value={String(size)}
          onChange={(e) => {
            setSize(Number(e.target.value));
            setPage(0);
          }}
          style={{ height: 28, border: `1px solid ${C.line}`, borderRadius: 4, background: "#FFFFFF" }}
        >
          <option value="25">25 rows</option>
          <option value="50">50 rows</option>
          <option value="100">100 rows</option>
        </select>
        <button type="button" onClick={() => setPage(Math.max(0, p - 1))} style={{ height: 28, padding: "0 10px", border: `1px solid ${C.line}`, background: "#FFFFFF", borderRadius: 4, cursor: "pointer" }}>
          ‹ Previous
        </button>
        <button type="button" onClick={() => setPage(Math.min(pages - 1, p + 1))} style={{ height: 28, padding: "0 10px", border: `1px solid ${C.line}`, background: "#FFFFFF", borderRadius: 4, cursor: "pointer" }}>
          Next ›
        </button>
      </div>
    ),
  };
}

/* ------------------------------------------------------------------ modal */

export type ModalField = {
  k: string;
  l: string;
  type?: "text" | "number" | "date" | "password" | "area" | "select";
  req?: boolean;
  /** Minimum characters — a reason that is kept on the record. */
  min?: number;
  init?: string;
  ph?: string;
  hint?: string;
  opts?: (string | { v: string; l: string })[];
};

export type ModalSpec = {
  title: string;
  sub?: string;
  notes?: { t: string; bg?: string; fg?: string }[];
  fields?: ModalField[];
  okL?: string;
  cancel?: string;
  danger?: boolean;
  vault?: boolean;
  /** Return a sentence to show as an error and keep the modal open, or nothing to close it. */
  done?: (v: Record<string, string>) => Promise<string | void> | string | void;
};

const ModalCtx = createContext<(m: ModalSpec | null) => void>(() => {});
const ToastCtx = createContext<(msg: string, undo?: () => void) => void>(() => {});
export const useModal = () => useContext(ModalCtx);
export const useToast = () => useContext(ToastCtx);

function ModalView({ m, close }: { m: ModalSpec; close: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries((m.fields ?? []).map((f) => [f.k, f.init ?? ""])));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState("");
  const check = () => {
    const e: Record<string, string> = {};
    for (const f of m.fields ?? []) {
      const v = vals[f.k] ?? "";
      if (f.req && !v.trim()) e[f.k] = "Required";
      else if (f.min && v.trim().length < f.min) e[f.k] = `At least ${f.min} characters — it is kept on the record`;
    }
    return e;
  };
  const ok = !Object.keys(check()).length;
  const base: CSSProperties = { width: "100%", minHeight: 36, padding: "8px 10px", border: "1px solid #C2C8D2", borderRadius: 4, fontSize: 14, lineHeight: "20px", background: "#FFFFFF", color: C.ink };
  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(26,30,40,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 520, maxWidth: "100%", maxHeight: "calc(100vh - 48px)", background: "#FFFFFF", borderRadius: 6, boxShadow: "0 8px 24px rgba(26,30,40,0.12)", display: "flex", flexDirection: "column", overflow: "hidden", animation: "lk-pop 200ms cubic-bezier(0.2,0,0.2,1)" }}
      >
        <div style={{ padding: "18px 24px 12px 24px" }}>
          <div style={{ fontSize: 18, lineHeight: "24px", fontWeight: 600, color: C.ink }}>{m.title}</div>
          {m.sub ? <div style={{ fontSize: 14, lineHeight: "21px", color: C.body, marginTop: 6, textWrap: "pretty" }}>{m.sub}</div> : null}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 24px 16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          {(m.notes ?? []).map((n, i) => (
            <div key={i} style={{ padding: "10px 12px", borderRadius: 4, fontSize: 13, lineHeight: "19px", background: n.bg ?? C.soft, color: n.fg ?? C.body, whiteSpace: "pre-wrap" }}>
              {n.t}
            </div>
          ))}
          {(m.fields ?? []).map((f) => {
            const err = errs[f.k];
            const st = { ...base, ...(err ? { borderColor: C.red } : {}) };
            const on = (v: string) => {
              setVals({ ...vals, [f.k]: v });
              setErrs({ ...errs, [f.k]: "" });
            };
            return (
              <label key={f.k} style={{ display: "block" }}>
                <span style={{ display: "flex", justifyContent: "space-between", ...LBL, marginBottom: 4 }}>
                  <span>{f.l}</span>
                  <span>{f.req || f.min ? "Required" : "Optional"}</span>
                </span>
                {f.type === "area" ? (
                  <textarea value={vals[f.k]} onChange={(e) => on(e.target.value)} placeholder={f.ph} rows={3} style={st} />
                ) : f.type === "select" ? (
                  <select value={vals[f.k]} onChange={(e) => on(e.target.value)} style={st}>
                    {(f.opts ?? []).map((o) => {
                      const x = typeof o === "string" ? { v: o, l: o } : o;
                      return (
                        <option key={x.v} value={x.v}>
                          {x.l}
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <input type={f.type ?? "text"} value={vals[f.k]} onChange={(e) => on(e.target.value)} placeholder={f.ph} style={st} autoComplete={f.type === "password" ? "off" : undefined} />
                )}
                {f.hint ? <span style={{ display: "block", fontSize: 12, color: C.muted, marginTop: 4 }}>{f.hint}</span> : null}
                {err ? <span style={{ display: "block", fontSize: 12, color: C.red, marginTop: 4 }}>{err}</span> : null}
              </label>
            );
          })}
          {fail ? <div style={{ fontSize: 13, color: C.red }}>{fail}</div> : null}
        </div>
        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.line2}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={close} style={{ height: 36, padding: "0 14px", border: "1px solid #C2C8D2", background: "#FFFFFF", borderRadius: 4, fontSize: 14, cursor: "pointer" }}>
            {m.cancel ?? "Cancel"}
          </button>
          {m.okL ? (
            <button
              type="button"
              title={ok ? "" : "Complete the required fields first"}
              style={ok && !busy ? btnStyle(m.danger ? "d" : m.vault ? "v" : "p") : BTN_OFF}
              onClick={async () => {
                const e = check();
                if (Object.keys(e).length) return setErrs(e);
                if (busy) return;
                setBusy(true);
                setFail("");
                const res = await m.done?.(vals);
                setBusy(false);
                if (typeof res === "string" && res) setFail(res);
                else close();
              }}
            >
              {busy ? "Saving…" : m.okL}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Wraps the Locker: one modal and one toast at a time, the design's dark toast with Undo. */
export function LockerOverlays({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<{ m: ModalSpec; key: number } | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void; key: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <ModalCtx.Provider value={(m) => setModal(m ? { m, key: Date.now() } : null)}>
      <ToastCtx.Provider value={(msg, undo) => setToast({ msg, undo, key: Date.now() })}>
        {children}
        {modal ? <ModalView key={modal.key} m={modal.m} close={() => setModal(null)} /> : null}
        {toast ? (
          <div
            role="status"
            style={{ position: "fixed", right: 24, bottom: 24, zIndex: 60, display: "flex", alignItems: "center", gap: 14, maxWidth: 520, padding: "12px 16px", background: C.ink, color: "#FFFFFF", borderRadius: 6, boxShadow: "0 8px 24px rgba(26,30,40,0.2)", fontSize: 14, animation: "lk-pop 150ms cubic-bezier(0.2,0,0.2,1)" }}
          >
            <span style={{ flex: 1 }}>{toast.msg}</span>
            {toast.undo ? (
              <button
                type="button"
                onClick={() => {
                  const u = toast.undo;
                  setToast(null);
                  u?.();
                }}
                style={{ border: "none", background: "transparent", color: "#DDD2FF", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
      </ToastCtx.Provider>
    </ModalCtx.Provider>
  );
}

/* ---------------------------------------------------------------- density */

const DensityCtx = createContext<"comfortable" | "compact">("comfortable");
export const useDensity = () => useContext(DensityCtx);
export const DensityProvider = DensityCtx.Provider;

/* ---------------------------------------------------------------- format */

export const nf = (n: number) => Number(n || 0).toLocaleString("en-IN");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "09 Oct 2026" from an ISO date. */
export function fd(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d} ${MON[Number(m) - 1]} ${y}`;
}
/** "09 Oct" from an ISO date. */
export function fds(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d} ${MON[Number(m) - 1]}`;
}
/** ₹1,23,456 from paise — whole rupees, as the design shows them. */
export function inr(paise: number | null | undefined): string {
  if (paise == null) return "—";
  const n = Math.round(paise / 100);
  return (n < 0 ? "−" : "") + "₹" + Math.abs(n).toLocaleString("en-IN");
}
export const initials = (n: string | null | undefined) =>
  String(n || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
