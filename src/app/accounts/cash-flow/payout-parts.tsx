"use client";

import * as React from "react";
import { Button, cx, Field, Input, MoneyInput } from "@/components/ui/primitives";
import { INVOICE_KINDS, payoutTone, TONE_LABEL, type PayoutTone } from "@/lib/engines/vendor-payouts";
import { parseRupees } from "@/lib/format";
import type { InvoiceInput } from "@/lib/services/vendor-payout-service";
import type { PayoutView } from "@/lib/services/vendor-payout-service";

/* ---------------------------------------------------------------------------
 * The pieces the payouts calendar, list, drawer and add dialog share: the
 * status colours, the invoice fields and the file upload behind them.
 * ------------------------------------------------------------------------- */

export const TONE_SKIN: Record<PayoutTone, { card: string; pill: string; dot: string }> = {
  overdue: { card: "border-l-danger bg-danger-soft/60", pill: "bg-danger-soft text-danger", dot: "bg-danger" },
  today: { card: "border-l-brand bg-brand-soft", pill: "bg-brand-soft text-[#5223E0]", dot: "bg-brand" },
  late: { card: "border-l-warn bg-warn-soft/70", pill: "bg-warn-soft text-warn-ink", dot: "bg-warn" },
  upcoming: { card: "border-l-line-strong bg-surface", pill: "bg-divider text-body", dot: "bg-line-strong" },
  held: { card: "border-l-muted bg-canvas", pill: "bg-canvas text-muted", dot: "bg-muted" },
  paid: { card: "border-l-success bg-success-soft/60 opacity-80", pill: "bg-success-soft text-success", dot: "bg-success" },
  cancelled: { card: "border-l-line bg-canvas opacity-60 line-through", pill: "bg-canvas text-muted", dot: "bg-line" },
};

export function toneOf(p: Pick<PayoutView, "status" | "payOn" | "dueDate">, today: string): PayoutTone {
  return payoutTone(p, today);
}

export function StatusPill({ tone }: { tone: PayoutTone }) {
  return (
    <span className={cx("inline-flex h-5 items-center rounded-[3px] px-1.5 text-[11px] font-medium whitespace-nowrap", TONE_SKIN[tone].pill)}>
      {TONE_LABEL[tone]}
    </span>
  );
}

/** "PR 12", "PO 15", the bill number — what a row is, in the fewest words. */
export function sourceWords(p: PayoutView): string {
  if (p.source === "purchase") return `Purchase · PR ${p.prNumber}${p.lots > 1 ? ` · ${p.lots} lots` : ""}`;
  return p.description ?? "Added by hand";
}

/* ----------------------------------------------------------------- upload */

export async function uploadInvoiceFile(file: File): Promise<{ id: string } | { error: string }> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/accounts/payouts/upload", { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !body.id) return { error: body.error ?? "The file could not be uploaded." };
    return { id: body.id };
  } catch {
    return { error: "The file could not be uploaded — check the connection and try again." };
  }
}

/* ---------------------------------------------------------- invoice draft */

export type InvoiceDraft = {
  key: number;
  kind: string;
  custom: boolean;
  invoiceNo: string;
  invoiceDate: string;
  amount: string;
  file: { name: string; id: string | null; uploading: boolean; error: string | null } | null;
};

export function blankInvoice(key: number, kind: string = INVOICE_KINDS[0]): InvoiceDraft {
  return { key, kind, custom: false, invoiceNo: "", invoiceDate: "", amount: "", file: null };
}

/** An empty draft row is simply left out; a half-filled one is sent and the server says what is missing. */
export function draftIsEmpty(d: InvoiceDraft): boolean {
  return !d.invoiceNo.trim() && !d.file && !d.amount.trim() && !d.invoiceDate;
}

export function draftToInput(d: InvoiceDraft): InvoiceInput {
  return {
    kind: d.kind.trim(),
    invoiceNo: d.invoiceNo.trim() || null,
    invoiceDate: d.invoiceDate || null,
    amountPaise: d.amount.trim() ? parseRupees(d.amount) : null,
    attachmentId: d.file?.id ?? null,
  };
}

/**
 * One invoice: what kind it is (the usual ones offered as chips, anything else
 * typed), its number, date, amount and the file. The file starts uploading the
 * moment it is chosen; saving waits for nothing but says if it did not make it.
 */
export function InvoiceFields({
  draft,
  onChange,
  onRemove,
}: {
  draft: InvoiceDraft;
  onChange: (next: InvoiceDraft) => void;
  onRemove?: () => void;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  // The latest draft, for the upload finishing after other fields were typed in.
  const latest = React.useRef(draft);
  React.useEffect(() => {
    latest.current = draft;
  });

  async function pick(file: File | undefined) {
    if (!file) return;
    onChange({ ...draft, file: { name: file.name, id: null, uploading: true, error: null } });
    const res = await uploadInvoiceFile(file);
    const now = latest.current;
    onChange({
      ...now,
      file: "id" in res
        ? { name: file.name, id: res.id, uploading: false, error: null }
        : { name: file.name, id: null, uploading: false, error: res.error },
    });
  }

  return (
    <div className="rounded-[6px] border border-line bg-canvas/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Invoice type</span>
        {onRemove ? (
          <button type="button" onClick={onRemove} className="cursor-pointer text-[12px] text-muted hover:text-danger">
            Remove
          </button>
        ) : null}
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {INVOICE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange({ ...draft, kind: k, custom: false })}
            className={cx(
              "h-7 cursor-pointer rounded-full border px-2.5 text-[12px] font-medium",
              !draft.custom && draft.kind === k
                ? "border-brand bg-brand-soft text-[#5223E0]"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange({ ...draft, kind: draft.custom ? draft.kind : "", custom: true })}
          className={cx(
            "h-7 cursor-pointer rounded-full border border-dashed px-2.5 text-[12px] font-medium",
            draft.custom ? "border-brand bg-brand-soft text-[#5223E0]" : "border-line-strong bg-surface text-muted hover:text-body",
          )}
        >
          + Other type
        </button>
      </div>
      {draft.custom ? (
        <Field label="Name this type" className="mb-3">
          <Input
            autoFocus
            value={draft.kind}
            maxLength={60}
            placeholder="e.g. Transport bill, Advance receipt"
            onChange={(e) => onChange({ ...draft, kind: e.target.value })}
          />
        </Field>
      ) : null}
      <div className="grid grid-cols-3 gap-2.5">
        <Field label="Number">
          <Input value={draft.invoiceNo} onChange={(e) => onChange({ ...draft, invoiceNo: e.target.value })} placeholder="INV-204" />
        </Field>
        <Field label="Date">
          <Input type="date" value={draft.invoiceDate} onChange={(e) => onChange({ ...draft, invoiceDate: e.target.value })} />
        </Field>
        <Field label="Amount">
          <MoneyInput value={draft.amount} onChange={(e) => onChange({ ...draft, amount: e.target.value })} placeholder="optional" />
        </Field>
      </div>
      <div className="mt-2.5 flex items-center gap-2.5">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button type="button" size="sm" onClick={() => fileRef.current?.click()} disabled={draft.file?.uploading}>
          {draft.file ? "Replace file" : "Upload file"}
        </Button>
        <span className="min-w-0 truncate text-[13px]">
          {draft.file ? (
            draft.file.uploading ? (
              <span className="text-muted">Uploading {draft.file.name}…</span>
            ) : draft.file.error ? (
              <span className="text-danger">{draft.file.error}</span>
            ) : (
              <span className="text-success">✓ {draft.file.name}</span>
            )
          ) : (
            <span className="text-muted">PDF, JPG or PNG</span>
          )}
        </span>
      </div>
    </div>
  );
}
