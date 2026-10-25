"use client";

import { NavLink } from "@/components/shell/nav-link";
import { erpBillRoadHref } from "@/lib/erp/trace-links";
import { useState } from "react";
import { phoneDisplay } from "@/lib/format";
import { Icon } from "../../_ui/icons";
import { Button, checkboxClass, cx, Textarea } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { insetClass, linkClass } from "../../_ui/look";
import { dueWord, STAGES, STAGE_SHORT, stageStep, type Stage } from "@/lib/erp/engines/logistics";
import type { Consignment } from "@/lib/erp/logistics";

/* ---------------------------------------------------------------------------
 * What every tab of the Logistics desk draws the same way: the stage strip,
 * the due pill, the LR thumbnail and the call link. A button's write goes
 * through the ERP's one `useAct` (re-exported here).
 * ------------------------------------------------------------------------- */

export { useAct } from "../../_ui/use-act";

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
      {!compact ? <span className="ml-2 text-xs font-medium whitespace-nowrap text-body">{STAGE_SHORT[STAGES[at] as Stage]}</span> : null}
    </div>
  );
}

export function DuePill({ day, today, prefix }: { day: string | null; today: string; prefix?: string }) {
  const w = dueWord(day, today);
  if (!w) return <span className="text-muted">—</span>;
  return (
    <Badge label={`${prefix ? `${prefix} ` : ""}${w.word}`} tone={w.tone === "danger" ? "danger" : w.tone === "warn" ? "warn" : "neutral"} />
  );
}

export function CallLink({ phone, name }: { phone: string | null; name: string | null }) {
  if (!phone) return <span className="text-xs text-muted">{name ? "No number — add it under Transporters" : "No transporter"}</span>;
  return (
    <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className={linkClass("brand", "inline-flex items-center gap-1 text-meta")}>
      <Icon n="phone" s={13} />
      {phoneDisplay(phone)}
    </a>
  );
}

/** The LR's photo, opened full size on a click. A PDF is a link, not a picture. */
export function LrThumb({ fileId, size = 56 }: { fileId: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!fileId)
    return (
      <span style={{ width: size, height: size }} className="flex flex-none items-center justify-center rounded-control border border-dashed border-line text-2xs text-muted">
        No photo
      </span>
    );
  const href = `/api/attachments/${fileId}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ width: size, height: size }} className="flex flex-none items-center justify-center overflow-hidden rounded-control border border-line bg-canvas">
      {broken ? (
        <span className="text-2xs font-medium">PDF</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={href} alt="LR" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      )}
    </a>
  );
}

export function BillRef({ c }: { c: Pick<Consignment, "id" | "orderNo" | "billNo"> }) {
  return (
    <NavLink href={erpBillRoadHref(c.id)} className={linkClass("brand", "font-mono text-meta")}>
      {c.billNo ?? `Order ${c.orderNo}`}
    </NavLink>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-8 text-center text-meta text-muted">{children}</div>;
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
    <label className={cx("flex items-start gap-2 bg-canvas text-sm", insetClass, disabled ? "opacity-60" : "cursor-pointer")}>
      <input type="checkbox" checked={value && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className={cx(checkboxClass, "mt-0.5")} />
      <span>
        <span className="font-medium text-ink">Tell the customer on WhatsApp</span>
        <span className="block text-meta text-muted">{disabled ? "Customer messages are switched off in ERP settings." : "Sent through Wati where it can be; otherwise it waits under Customer messages to send by hand."}</span>
      </span>
    </label>
  );
}

/** "LR 1048821", but never "LR LR77005" when the number already says so. */
export function lrLabel(no: string | null | undefined): string {
  if (!no) return "No LR";
  return /^LR\b|^LR[-\s\d]/i.test(no) ? no : `LR ${no}`;
}

/**
 * "Are you sure — and why?": the one dialog for a Logistics step that needs a
 * reason (reopening a delivered bill, voiding an LR). The reason must be a few
 * characters, because it is what somebody reads on the record later.
 */
export function ReasonDialog({
  open,
  title,
  body,
  placeholder = "Why?",
  keepLabel,
  confirmLabel,
  tone = "primary",
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  placeholder?: string;
  keepLabel: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  if (!open) return null;
  return (
    <ErpDialog onClose={onClose} label={title} size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-2">
        <p className="text-sm text-body">{body}</p>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={placeholder} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{keepLabel}</Button>
        <Button variant={tone} disabled={pending || reason.trim().length < 3} onClick={() => onConfirm(reason)}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
