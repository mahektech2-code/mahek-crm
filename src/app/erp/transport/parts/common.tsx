"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { dueWord, STAGES, STAGE_SHORT, stageStep, type Stage } from "@/lib/erp/engines/logistics";
import type { Consignment } from "@/lib/erp/logistics";
import type { Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * What every tab of the Logistics desk draws the same way: the stage strip,
 * the due pill, the LR thumbnail, the call link, and the one way a button
 * runs a write — toast the answer, refresh the page.
 * ------------------------------------------------------------------------- */

export function useAct() {
  const router = useRouter();
  const { push } = useToast();
  const [pending, start] = useTransition();
  const run = <T,>(fn: () => Promise<Result<T>>, after?: (r: Result<T>) => void) =>
    new Promise<Result<T>>((resolve) =>
      start(async () => {
        const r = await fn();
        if (r.ok) push(r.message ?? "Saved");
        else push(r.fieldErrors?.[0]?.message ?? r.error, "error");
        after?.(r);
        router.refresh();
        resolve(r);
      }),
    );
  return { run, pending };
}

/** The six steps of a consignment, the current one filled. */
export function StageStrip({ stage, compact = false }: { stage: string; compact?: boolean }) {
  const at = stageStep(stage);
  return (
    <div className="flex items-center gap-1" title={STAGE_SHORT[STAGES[at] as Stage]}>
      {STAGES.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          <span
            className={cx(
              "block rounded-full",
              compact ? "h-1.5 w-5" : "h-2 w-6",
              i < at ? "bg-brand" : i === at ? (s === "Close - Received to Party" ? "bg-success" : "bg-brand") : "bg-divider",
            )}
          />
        </span>
      ))}
      {!compact ? <span className="ml-2 text-[12px] font-medium whitespace-nowrap text-body">{STAGE_SHORT[STAGES[at] as Stage]}</span> : null}
    </div>
  );
}

export function DuePill({ day, today, prefix }: { day: string | null; today: string; prefix?: string }) {
  const w = dueWord(day, today);
  if (!w) return <span className="text-muted">—</span>;
  return (
    <Badge tone={w.tone === "danger" ? "danger" : w.tone === "warn" ? "warn" : "neutral"}>
      {prefix ? `${prefix} ` : ""}
      {w.word}
    </Badge>
  );
}

export function CallLink({ phone, name }: { phone: string | null; name: string | null }) {
  if (!phone) return <span className="text-[12px] text-muted">{name ? "No number — add it under Transporters" : "No transporter"}</span>;
  return (
    <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 text-[13px] font-medium">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
      </svg>
      {phone}
    </a>
  );
}

/** The LR's photo, opened full size on a click. A PDF is a link, not a picture. */
export function LrThumb({ fileId, size = 56 }: { fileId: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!fileId)
    return (
      <span style={{ width: size, height: size }} className="flex flex-none items-center justify-center rounded-[4px] border border-dashed border-line text-[10px] text-muted">
        No photo
      </span>
    );
  const href = `/api/attachments/${fileId}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ width: size, height: size }} className="flex flex-none items-center justify-center overflow-hidden rounded-[4px] border border-line bg-canvas">
      {broken ? (
        <span className="text-[11px] font-medium">PDF</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={href} alt="LR" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      )}
    </a>
  );
}

export function BillRef({ c }: { c: Pick<Consignment, "id" | "orderNo" | "billNo"> }) {
  return (
    <Link href={`/erp/transport/${c.id}`} className="font-mono text-[13px]">
      {c.billNo ?? `Order ${c.orderNo}`}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-8 text-center text-sm text-muted">{children}</div>;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Bills grouped by the LR they travel under — one LR is one consignment on the road. */
export function byLr(cs: Consignment[]): { key: string; lrId: string | null; bills: Consignment[] }[] {
  const out = new Map<string, { key: string; lrId: string | null; bills: Consignment[] }>();
  for (const c of cs) {
    const key = c.lrId ?? `bill:${c.id}`;
    const g = out.get(key) ?? { key, lrId: c.lrId, bills: [] };
    g.bills.push(c);
    out.set(key, g);
  }
  return [...out.values()];
}

export function sumPackages(cs: { packages: number | null }[]): number | null {
  return cs.every((c) => c.packages != null) ? cs.reduce((a, c) => a + (c.packages ?? 0), 0) : null;
}

export function sumLitres(cs: { litres: number | null }[]): number {
  return Math.round(cs.reduce((a, c) => a + (c.litres ?? 0), 0) * 10) / 10;
}

/** A checkbox column that ticks every row it is given. */
export function useTicks() {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const setMany = (ids: string[], on: boolean) =>
    setTicked((s) => {
      const n = new Set(s);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });
  return { ticked, toggle, setMany, clear: () => setTicked(new Set()) };
}

export function NotifyToggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cx("flex items-start gap-2 rounded-[4px] border border-line bg-canvas px-3 py-2 text-sm", disabled ? "opacity-60" : "cursor-pointer")}>
      <input type="checkbox" checked={value && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-[15px] w-[15px] accent-[#6835FB]" />
      <span>
        <span className="font-medium text-ink">Tell the customer on WhatsApp</span>
        <span className="block text-[12px] text-muted">{disabled ? "Customer messages are switched off in ERP settings." : "Sent through Wati where it can be; otherwise it waits under Customer messages to send by hand."}</span>
      </span>
    </label>
  );
}

/** "LR 1048821", but never "LR LR77005" when the number already says so. */
export function lrLabel(no: string | null | undefined): string {
  if (!no) return "No LR";
  return /^LR\b|^LR[-\s\d]/i.test(no) ? no : `LR ${no}`;
}
