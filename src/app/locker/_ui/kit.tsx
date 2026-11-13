"use client";

import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Modal } from "@/components/ui/modal";
import { Pager } from "@/components/ui/pager";
import { Badge, Button, Card as UiCard, Field, Input, Select, Textarea, cx, type Tone as BadgeTone } from "@/components/ui/primitives";
import { CRIT, STATUS, TIER, type Status, type Tier } from "@/lib/locker/engine";
import { LkIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * THE LOCKER'S PARTS, drawn in the ERP's v4 design system. Each one is the
 * shared component the ERP, CRM, HRMS, Tasks and Studio already use —
 * `Button`, `Badge`, `Card`, `PageHeader`'s type, `Pager`, `Modal`, `Field` —
 * or a thin wrapper on one, so the Locker reads like the rest of MahekOne and
 * picks up any change to the v4 look for free. No hex lives here: colours are
 * the theme's tokens (Tailwind classes, or `C.*`, which are CSS variables).
 *
 * The names are the ones the Locker's screens were written against, so a
 * screen did not have to change to change its look.
 * ------------------------------------------------------------------------- */

import { C, LBL, MONO, btnStyle, type BtnKind } from "@/lib/locker/style";
/* The pure values live in lib/locker/style.ts so SERVER pages can use them
   too — a value exported from this client module is only a reference there. */
export { C, LBL, MONO, btnStyle, type BtnKind };

export const BTN_OFF: CSSProperties = { ...btnStyle("s"), color: C.faint, background: C.soft, border: `1px solid ${C.line}`, cursor: "not-allowed" };

const VARIANT: Record<BtnKind, "primary" | "secondary" | "danger" | "ghost"> = { p: "primary", s: "secondary", d: "danger", v: "primary", g: "ghost" };

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
  return (
    <Button
      type={type}
      variant={VARIANT[kind]}
      size={small ? "sm" : "md"}
      disabled={disabled}
      title={disabled ? why : undefined}
      onClick={disabled ? undefined : onClick}
      className={cx("gap-1.5", kind === "g" && "border-transparent text-brand-hover hover:bg-brand-soft")}
      style={style}
    >
      {children}
    </Button>
  );
}

/* ------------------------------------------------------------------ badges */

const TONE_BY_COLOUR: Record<string, BadgeTone> = {};
for (const t of [...Object.values(STATUS), ...Object.values(CRIT)]) TONE_BY_COLOUR[`${t.bg}|${t.fg}`] = t.tone;

/** A badge. Given a tone it is the shared `Badge`; given colours (older call sites) it is drawn in them. */
export function Pill({ label, bg, fg, tone, style }: { label: ReactNode; bg?: string; fg?: string; tone?: BadgeTone; style?: CSSProperties }) {
  const t = tone ?? (bg && fg ? TONE_BY_COLOUR[`${bg}|${fg}`] : undefined);
  if (t && !style) return <Badge tone={t}>{label}</Badge>;
  return (
    <span className="ui-badge inline-flex h-5 items-center gap-1 rounded-[3px] px-1.5 text-[11px] font-medium whitespace-nowrap" style={{ background: bg, color: fg, ...style }}>
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  const t = STATUS[status] ?? STATUS.active;
  return (
    <Badge tone={t.tone} className={t.ring ? "ring-1 ring-current/25 ring-inset" : undefined}>
      {(t.glyph ?? "") + t.label}
    </Badge>
  );
}

export function CritPill({ crit }: { crit: number }) {
  const t = CRIT[crit] ?? CRIT[2];
  return <Badge tone={t.tone}>{t.label}</Badge>;
}

export function TierPill({ tier }: { tier: Tier }) {
  if (tier === "restricted")
    return (
      <span className="ui-badge inline-flex h-5 items-center gap-1 rounded-[3px] bg-ink px-1.5 text-[11px] font-semibold tracking-label whitespace-nowrap text-white uppercase">
        <LkIcon name="key" size={11} />
        Restricted
      </span>
    );
  const t = TIER[tier] ?? TIER.standard;
  return (
    <Badge tone={t.tone} className="tracking-label uppercase">
      {t.label}
    </Badge>
  );
}

const TAG_TONE: Record<string, BadgeTone> = { red: "danger", amber: "warn", blue: "brand", green: "success", grey: "muted", violet: "neutral" };
export function Tag({ label, tone }: { label: string; tone: "red" | "amber" | "blue" | "green" | "grey" | "violet" }) {
  return <Badge tone={TAG_TONE[tone]}>{label}</Badge>;
}

/* ---------------------------------------------------------------- surfaces */

export const card: CSSProperties = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: "var(--radius-card, 8px)", overflow: "hidden" };
export const vaultCard: CSSProperties = card;
/** A vault card carries an ink left edge — the one mark of the vault besides its lock. */
export const vaultEdge: CSSProperties = { ...card, boxShadow: `inset 3px 0 0 ${C.ink}` };

export function Card({ children, style, vault }: { children: ReactNode; style?: CSSProperties; vault?: boolean }) {
  return (
    <UiCard className="overflow-hidden" style={{ ...(vault ? { boxShadow: `inset 3px 0 0 ${C.ink}` } : {}), ...style }}>
      {children}
    </UiCard>
  );
}

/** A card's heading bar, the shared `CardHeader`'s shape; a vault card's carries the lock. */
export function CardHead({ title, sub, right, vault }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; vault?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-base leading-6 font-semibold text-ink">
          {vault ? (
            <span className="flex text-muted">
              <LkIcon name="key" size={15} />
            </span>
          ) : null}
          {title}
        </div>
        {sub ? <div className="mt-0.5 text-[13px] text-muted">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}

/**
 * The page head: the v4 page header — the title and its actions, the
 * explanation behind nothing (written small under the title), and the
 * crumb kept as the eyebrow the ERP uses above a record's name.
 */
export function PageHead({ crumb, title, sub, actions, vault }: { crumb: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode; vault?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6 pb-4">
      <div className="min-w-0 flex-[1_1_420px]">
        <div className="flex items-center gap-1.5 text-xs font-medium tracking-label text-muted uppercase">
          {vault ? <LkIcon name="key" size={12} /> : null}
          {crumb}
        </div>
        <h1 className="mt-1 text-[28px] leading-[34px] font-semibold text-ink">{title}</h1>
        {sub ? <p className="mt-1 max-w-[820px] text-[13px] leading-[18px] text-pretty text-muted">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-none flex-wrap items-center gap-2.5 print:hidden">{actions}</div> : null}
    </div>
  );
}

export function Body({ children, gap = 12, pad }: { children: ReactNode; gap?: number; pad?: string }) {
  return (
    <div className={cx("flex flex-col", pad ? undefined : "px-6 pb-10")} style={{ gap, ...(pad ? { padding: pad } : {}) }}>
      {children}
    </div>
  );
}

/** Underlined tabs — the ERP list's own tab strip. */
export function Tabs<K extends string>({ tabs, value, onPick }: { tabs: { key: K; label: ReactNode; n?: string; red?: boolean }[]; value: K; onPick: (k: K) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap items-center gap-x-5 border-b border-line">
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onPick(t.key)}
            className={cx(
              "-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 py-2 text-sm whitespace-nowrap",
              on ? "border-brand font-semibold text-ink" : "border-transparent font-medium text-muted hover:text-body",
              t.red && !on && "text-danger",
            )}
          >
            {t.label}
            {t.n != null ? <span className="rounded-full bg-canvas px-1.5 text-2xs leading-[17px] font-semibold text-body">{t.n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A small segmented switch: Table / Cards, Month / Year, Comfortable / Compact — the v4 pager's rows switch. */
export function Segmented<K extends string>({ opts, value, onPick }: { opts: { key: K; label: string }[]; value: K; onPick: (k: K) => void; dark?: boolean }) {
  return (
    <span role="group" className="flex flex-none gap-0.5 rounded-[7px] bg-canvas p-0.5">
      {opts.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(o.key)}
            className={cx(
              "cursor-pointer rounded-[5px] px-2.5 py-1 text-[12.5px]",
              on ? "bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(20,20,30,0.08)]" : "font-medium text-muted hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

/** A filter that toggles — the ERP toolbar's toggle. */
export function Chip({ label, on, onFlip }: { label: ReactNode; on: boolean; onFlip: () => void; vault?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onFlip}
      className={cx(
        "flex h-8 cursor-pointer items-center gap-1.5 rounded-control border px-3 text-[13px] font-medium whitespace-nowrap",
        on ? "border-brand bg-brand-soft text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas",
      )}
    >
      {label}
    </button>
  );
}

export function SearchBox({ value, onChange, placeholder, width = 240 }: { value: string; onChange: (v: string) => void; placeholder: string; width?: number }) {
  return (
    <span className="relative flex-none" style={{ width }}>
      <span className="pointer-events-none absolute top-1/2 left-2.5 flex -translate-y-1/2 text-muted">
        <LkIcon name="search" />
      </span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="pl-8" />
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
    <span className="relative flex-none" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setQ("");
        }}
        className={cx(
          "flex h-8 cursor-pointer items-center gap-2 rounded-control border bg-surface px-2.5 text-[13px] font-medium text-ink",
          open || value ? "border-brand" : "border-line hover:bg-canvas",
        )}
      >
        <span className="text-2xs font-medium tracking-label text-muted uppercase">{k}</span>
        <span className="max-w-[200px] truncate">{label}</span>
        <span className="text-faint">▾</span>
      </button>
      {open ? (
        <div className="absolute top-10 left-0 z-30 w-[340px] overflow-hidden rounded-card border border-line bg-surface shadow-[0_8px_24px_rgba(15,27,51,0.12)]">
          <div className="border-b border-divider p-2">
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={ph} aria-label={ph} />
          </div>
          <div className="max-h-80 overflow-y-auto">
            {shown.map((o) => (
              <button
                key={o.v + o.l}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(o.v);
                }}
                className={cx(
                  "flex w-full cursor-pointer items-center gap-2.5 border-t border-divider px-3 py-2 text-left text-sm",
                  o.v === value ? "bg-brand-soft text-brand-hover" : "bg-surface text-ink hover:bg-canvas",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.l}</span>
                <span className="flex-none text-xs text-muted">{o.m ?? ""}</span>
              </button>
            ))}
            {!hits.length ? <div className="p-3 text-[13px] text-muted">Nothing matches “{q}”.</div> : null}
          </div>
          {hits.length > shown.length ? (
            <div className="border-t border-divider px-3 py-2 text-xs text-muted">Showing 60 of {hits.length.toLocaleString("en-IN")} — keep typing to narrow it down</div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/** Paging for a long table: the shared v4 pager. */
export function usePager(total: number, initialSize = 25) {
  const [size, setSize] = useState(initialSize);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, pages);
  return {
    slice: <T,>(arr: T[]) => arr.slice((p - 1) * size, (p - 1) * size + size),
    reset: () => setPage(1),
    footer: (
      <div className="border-t border-divider">
        <Pager
          look="v4"
          total={total}
          page={p}
          perPage={size}
          onPage={setPage}
          onPerPage={(n) => {
            setSize(n);
            setPage(1);
          }}
        />
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

/** The shared `Modal`, filled from a spec: notes, then `Field`s, then Cancel and the action. */
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
  const submit = async () => {
    const e = check();
    if (Object.keys(e).length) return setErrs(e);
    if (busy) return;
    setBusy(true);
    setFail("");
    const res = await m.done?.(vals);
    setBusy(false);
    if (typeof res === "string" && res) setFail(res);
    else close();
  };
  return (
    <Modal
      open
      onClose={close}
      title={m.title}
      footer={
        <>
          <Button onClick={close}>{m.cancel ?? "Cancel"}</Button>
          {m.okL ? (
            <Button variant={m.danger ? "danger" : "primary"} disabled={!ok || busy} title={ok ? undefined : "Complete the required fields first"} onClick={submit}>
              {busy ? "Saving…" : m.okL}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {m.sub ? <p className="text-sm leading-[21px] text-pretty text-body">{m.sub}</p> : null}
        {(m.notes ?? []).map((n, i) => (
          <div key={i} className="rounded-control border border-line bg-canvas px-3 py-2.5 text-[13px] leading-[19px] whitespace-pre-wrap text-body">
            {n.t}
          </div>
        ))}
        {(m.fields ?? []).map((f) => {
          const err = errs[f.k];
          const on = (v: string) => {
            setVals({ ...vals, [f.k]: v });
            setErrs({ ...errs, [f.k]: "" });
          };
          return (
            <Field key={f.k} label={f.l} required={!!(f.req || f.min)} optional={!(f.req || f.min)} hint={f.hint} hintShown error={err || null}>
              {f.type === "area" ? (
                <Textarea value={vals[f.k]} onChange={(e) => on(e.target.value)} placeholder={f.ph} rows={3} invalid={!!err} />
              ) : f.type === "select" ? (
                <Select value={vals[f.k]} onChange={(e) => on(e.target.value)}>
                  {(f.opts ?? []).map((o) => {
                    const x = typeof o === "string" ? { v: o, l: o } : o;
                    return (
                      <option key={x.v} value={x.v}>
                        {x.l}
                      </option>
                    );
                  })}
                </Select>
              ) : (
                <Input type={f.type ?? "text"} value={vals[f.k]} onChange={(e) => on(e.target.value)} placeholder={f.ph} invalid={!!err} autoComplete={f.type === "password" ? "off" : undefined} />
              )}
            </Field>
          );
        })}
        {fail ? <div className="text-[13px] text-danger">{fail}</div> : null}
      </div>
    </Modal>
  );
}

/** Wraps the Locker: one modal and one toast at a time; the toast keeps the design's Undo. */
export function LockerOverlays({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<{ m: ModalSpec; key: number } | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void; key: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ModalCtx.Provider value={(m) => setModal(m ? { m, key: Date.now() } : null)}>
      <ToastCtx.Provider value={(msg, undo) => setToast({ msg, undo, key: Date.now() })}>
        {children}
        {modal ? <ModalView key={modal.key} m={modal.m} close={() => setModal(null)} /> : null}
        {toast ? (
          <div role="status" className="fixed bottom-6 left-1/2 z-[90] flex max-w-[520px] -translate-x-1/2 items-center gap-3.5 rounded-control bg-ink px-4 py-3 text-sm text-white shadow-[0_8px_24px_rgba(15,27,51,0.2)]">
            <span className="flex-1">{toast.msg}</span>
            {toast.undo ? (
              <button
                type="button"
                onClick={() => {
                  const u = toast.undo;
                  setToast(null);
                  u?.();
                }}
                className="cursor-pointer text-sm font-semibold text-brand-softer"
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
