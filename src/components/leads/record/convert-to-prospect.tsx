"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { ProductField } from "@/components/products/product-field";
import { convertLeadToProspect } from "@/lib/actions/lead-calling-desk";
import {
  PROSPECT_ANSWERS,
  PROSPECT_CUSTOMER_TYPES,
  faultFor,
  mergeProspectAnswers,
  type ProspectAnswerField,
  type ProspectAnswers,
} from "@/lib/engines/lead-prospect-answers";

/* ---------------------------------------------------------------------------
 * CONVERT A SUSPECT TO PROSPECT, FROM THE RECORD PAGE.
 *
 * The page used to draw seven missing answers under "To reach Prospect" with
 * nowhere to give them: the form that collects them lived on the Calling desk's
 * own record. This is that form, on this page, and it is the SAME act —
 * `convertLeadToProspect`, which falls back to a Sales Manager request itself
 * when `leads.callingDeskDirectPromotion` is off. Nothing here moves a stage.
 *
 * ALL SEVEN OR NOTHING, and the screen is the courtesy, not the rule. The same
 * `lead-prospect-answers` engine the server refuses on draws the field errors
 * here, so the form never offers a press the server would turn away for a reason
 * it could have named. Every fault is shown at once, what was typed is kept, and
 * a second press while the first is in flight is ignored.
 *
 * What the record already holds validly is shown as given and is not asked
 * again — nobody retypes a call's answers.
 * ------------------------------------------------------------------------- */

export type ConvertRecord = {
  customerId: string;
  name: string;
  salesType: string | null;
  customerType: string | null;
  monthlyLitres: number | null;
  competitor: string | null;
  requiredProductId: string | null;
  requiredProductName: string | null;
  contactPerson: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
};

type Coded = { code: string; label: string };

type Ctx = {
  open: () => void;
  /** Why the button is dead, or null where it works. */
  blocked: string | null;
};

const ConvertCtx = React.createContext<Ctx | null>(null);

const PRIVATE_LIMITED_USER = "direct_private_limited_user";

/**
 * Holds the one dialog for the whole page, so the header button, the gate card's
 * button and every "Answer" link open the same form rather than three copies.
 */
export function ConvertProvider({
  record,
  reasons,
  directPromotion,
  day,
  blocked,
  children,
}: {
  record: ConvertRecord;
  reasons: Coded[];
  directPromotion: boolean;
  /** The business date, `YYYY-MM-DD` — read on the server, never off a clock here. */
  day: string;
  blocked: string | null;
  children: React.ReactNode;
}) {
  const [shown, setShown] = React.useState(false);
  const value = React.useMemo<Ctx>(() => ({ open: () => setShown(true), blocked }), [blocked]);
  return (
    <ConvertCtx.Provider value={value}>
      {children}
      {shown ? (
        <ConvertDialog
          key={record.customerId}
          record={record}
          reasons={reasons}
          directPromotion={directPromotion}
          day={day}
          onClose={() => setShown(false)}
        />
      ) : null}
    </ConvertCtx.Provider>
  );
}

/** The primary button. Drawn disabled, with the reason on hover, where it cannot be used. */
export function ConvertButton({ label = "Convert to Prospect", size }: { label?: string; size?: "sm" }) {
  const ctx = React.useContext(ConvertCtx);
  if (!ctx) return null;
  return (
    <Button
      variant="primary"
      size={size}
      disabled={ctx.blocked !== null}
      title={ctx.blocked ?? "Answer the seven questions a Prospect needs, then convert."}
      onClick={ctx.open}
    >
      {label}
    </Button>
  );
}

/** A missing condition's way in: the same dialog, opened where the gap is named. */
export function AnswerLink({ children = "Answer" }: { children?: React.ReactNode }) {
  const ctx = React.useContext(ConvertCtx);
  if (!ctx || ctx.blocked !== null) return null;
  return (
    <button
      type="button"
      onClick={ctx.open}
      className="cursor-pointer border-0 bg-transparent p-0 text-xs whitespace-nowrap text-brand underline-offset-2 hover:underline"
    >
      {children}
    </button>
  );
}

/** Whether any of the seven can be answered from here. */
export function useConvertAvailable(): boolean {
  const ctx = React.useContext(ConvertCtx);
  return Boolean(ctx) && ctx!.blocked === null;
}

/* --------------------------------------------------------------- the dialog */

function typeLabel(v: string | null): string {
  return PROSPECT_CUSTOMER_TYPES.find((t) => t.value === v)?.label ?? (v ?? "");
}

function ConvertDialog({
  record,
  reasons,
  directPromotion,
  day,
  onClose,
}: {
  record: ConvertRecord;
  reasons: Coded[];
  directPromotion: boolean;
  day: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const reasonCodes = reasons.map((r) => r.code);

  /* What is typed. Kept across a refusal, so a fault never costs an answer. */
  const [customerType, setCustomerType] = React.useState("");
  const [litres, setLitres] = React.useState("");
  const [competitor, setCompetitor] = React.useState("");
  const [productId, setProductId] = React.useState<string | null>(null);
  const [contact, setContact] = React.useState("");
  const [nextAction, setNextAction] = React.useState("");
  const [nextDate, setNextDate] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [salesType, setSalesType] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);

  const record7: Partial<ProspectAnswers> = {
    customerType: record.customerType,
    monthlyLitres: record.monthlyLitres,
    competitor: record.competitor,
    requiredProductId: record.requiredProductId,
    contactPerson: record.contactPerson,
    nextAction: record.nextAction,
    nextActionDate: record.nextActionDate,
  };
  const supplied: Partial<ProspectAnswers> = {
    customerType: customerType || null,
    monthlyLitres: litres.trim() === "" ? null : litres.trim(),
    competitor: competitor || null,
    requiredProductId: productId,
    contactPerson: contact || null,
    nextAction: nextAction || null,
    nextActionDate: nextDate || null,
    reasonCode: reason || null,
  };
  const opts = { today: day, reasonCodes };
  const { merged, write } = mergeProspectAnswers(record7, supplied, opts);

  /* Which of the seven the RECORD already answers validly — shown, not asked. */
  const recordOnly = mergeProspectAnswers(record7, {}, opts).merged;
  const onRecord = (f: ProspectAnswerField): boolean => f !== "reasonCode" && faultFor(f, recordOnly, opts) === null;
  const nextOnRecord = onRecord("nextAction") && onRecord("nextActionDate");

  const errs: Partial<Record<string, string>> = {};
  for (const f of PROSPECT_ANSWERS) {
    const fields: ProspectAnswerField[] = f.field === "nextAction" ? ["nextAction", "nextActionDate"] : [f.field];
    for (const field of fields) {
      const fault = faultFor(field, merged, { ...opts, requireFutureDate: Boolean(write.nextActionDate) });
      if (fault) errs[field] = fault.message;
    }
  }
  const needsSalesType = record.salesType === null;
  if (needsSalesType && !salesType) errs.salesType = "Choose how this lead will be sold.";
  const shown = (k: string) => (tried ? (errs[k] ?? serverErrors[k]) : serverErrors[k]);
  const missingCount = PROSPECT_ANSWERS.filter((a) =>
    a.field === "nextAction" ? errs.nextAction || errs.nextActionDate : errs[a.field],
  ).length;
  const answered = PROSPECT_ANSWERS.length - missingCount;

  async function submit() {
    if (inFlight.current) return;
    setTried(true);
    setServerErrors({});
    setError(null);
    if (Object.keys(errs).length > 0) {
      setError(
        `Not ready: ${missingCount === 0 ? "choose a sales type" : `${missingCount} of the 7 answers ${missingCount === 1 ? "is" : "are"} missing or not valid`}. Nothing has been changed.`,
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    let result;
    try {
      result = await convertLeadToProspect({
        customerId: record.customerId,
        reasonCode: reason,
        note: note.trim() || undefined,
        customerType: write.customerType ? (write.customerType as never) : undefined,
        monthlyLitres: write.monthlyLitres !== undefined && write.monthlyLitres !== null ? Number(write.monthlyLitres) : undefined,
        competitor: write.competitor?.trim() || undefined,
        requiredProductId: write.requiredProductId || undefined,
        contactPerson: write.contactPerson?.trim() || undefined,
        nextAction: write.nextAction?.trim() || undefined,
        nextActionDate: write.nextActionDate || undefined,
        /* "Private Limited(User)" is a label for a Direct sale: it climbs the Direct ladder. */
        salesType: needsSalesType
          ? salesType === PRIVATE_LIMITED_USER
            ? "direct"
            : (salesType as "direct" | "third_party")
          : undefined,
      });
    } catch {
      result = null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (!result) {
      setError("That did not go through. Nothing was changed — check your connection and try again.");
      return;
    }
    if (!result.ok) {
      const byField: Partial<Record<string, string>> = {};
      for (const fe of result.fieldErrors ?? []) byField[fe.field] ??= fe.message;
      setServerErrors(byField);
      setError(result.error);
      return;
    }
    onClose();
    toast.push(result.message ?? "Converted to Prospect.");
    router.refresh();
  }

  const row = (n: number, field: ProspectAnswerField, label: string, done: boolean, body: React.ReactNode, err?: string) => (
    <div className="grid grid-cols-[26px_1fr] gap-2.5 border-t border-divider py-2.5 first:border-t-0">
      <span
        className={cx(
          "mt-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold",
          done ? "bg-success-soft text-success" : err ? "border border-danger bg-danger-soft text-danger" : "border border-warn-line bg-warn-soft text-warn-ink",
        )}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0" data-field={field}>
        <div className="mb-1 flex items-baseline justify-between gap-3 text-xs font-bold text-ink">
          <span>{label}</span>
          <span className={cx("text-[11px] font-semibold", done ? "text-success" : err ? "text-danger" : "text-warn-ink")}>
            {done ? "on the record" : "needed"}
          </span>
        </div>
        {body}
        {err ? (
          <p role="alert" className="mt-1 mb-0 text-xs text-danger">
            {err}
          </p>
        ) : null}
      </div>
    </div>
  );
  const readOnly = (text: React.ReactNode) => (
    <div className="flex min-h-[34px] items-center rounded-[4px] border border-line bg-canvas px-2.5 text-[13px] text-ink">{text}</div>
  );

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      width={640}
      title={
        <div>
          <div>Convert to Prospect</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{record.name} · all seven answers are needed</div>
        </div>
      }
      footer={
        <>
          <span className="mr-auto max-w-[320px] text-[11.5px] leading-snug text-muted">
            {directPromotion
              ? "Moves the lead to Prospect now. A Sales Manager's verification call comes next, before Qualification opens."
              : "Sends the lead to the Sales Manager to verify. It is not a Prospect until they confirm."}
          </span>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "Converting…" : directPromotion ? "Convert to Prospect" : "Send for verification"}
          </Button>
        </>
      }
    >
      <div className="mb-2 flex items-center gap-2.5 text-xs text-muted">
        <span>
          <b className="text-ink">{answered} of 7</b> answers in
        </span>
        <div className="h-[5px] flex-1 overflow-hidden rounded-[3px] bg-divider">
          <div className="h-full bg-brand" style={{ width: `${(answered / 7) * 100}%` }} />
        </div>
      </div>

      {needsSalesType ? (
        <div className="mb-2 rounded-[4px] border border-line p-2.5">
          <div className="mb-1 text-xs font-bold text-ink">How will this lead be sold?</div>
          <Select value={salesType} onChange={(e) => setSalesType(e.target.value)} className="w-full" aria-label="Sales type">
            <option value="">Pick one…</option>
            <option value="direct">Direct customer</option>
            <option value="third_party">Third Party Customer</option>
            <option value={PRIVATE_LIMITED_USER}>Private Limited(User)</option>
          </Select>
          {shown("salesType") ? <p role="alert" className="mt-1 mb-0 text-xs text-danger">{shown("salesType")}</p> : null}
        </div>
      ) : null}

      {row(
        1,
        "customerType",
        "What kind of business is this?",
        onRecord("customerType"),
        onRecord("customerType") ? (
          readOnly(typeLabel(record.customerType))
        ) : (
          <Select value={customerType} onChange={(e) => setCustomerType(e.target.value)} className="w-full" aria-label="Business type" aria-invalid={Boolean(shown("customerType"))}>
            <option value="">Choose…</option>
            {PROSPECT_CUSTOMER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        ),
        shown("customerType"),
      )}
      {row(
        2,
        "monthlyLitres",
        "How many litres a month do they use?",
        onRecord("monthlyLitres"),
        onRecord("monthlyLitres") ? (
          readOnly(`${record.monthlyLitres} litres / month`)
        ) : (
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={litres}
            onChange={(e) => setLitres(e.target.value)}
            placeholder="Litres a month"
            aria-label="Monthly litres"
            aria-invalid={Boolean(shown("monthlyLitres"))}
          />
        ),
        shown("monthlyLitres"),
      )}
      {row(
        3,
        "competitor",
        "Which brand are they using now?",
        onRecord("competitor"),
        onRecord("competitor") ? (
          readOnly(record.competitor)
        ) : (
          <Input value={competitor} onChange={(e) => setCompetitor(e.target.value)} placeholder="Competitor's brand" aria-label="Competitor" aria-invalid={Boolean(shown("competitor"))} />
        ),
        shown("competitor"),
      )}
      {row(
        4,
        "requiredProductId",
        "Which of our products do they need?",
        onRecord("requiredProductId"),
        onRecord("requiredProductId") ? (
          readOnly(record.requiredProductName ?? "Product on the record")
        ) : (
          <ProductField customerId={record.customerId} productId={productId} productName={null} disabled={busy} onPick={setProductId} />
        ),
        shown("requiredProductId"),
      )}
      {row(
        5,
        "contactPerson",
        "Who should we ask for when we call?",
        onRecord("contactPerson"),
        onRecord("contactPerson") ? (
          readOnly(record.contactPerson)
        ) : (
          <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact person's name" aria-label="Contact person" aria-invalid={Boolean(shown("contactPerson"))} />
        ),
        shown("contactPerson"),
      )}
      {row(
        6,
        "nextAction",
        "What happens next, and when?",
        nextOnRecord,
        nextOnRecord ? (
          readOnly(`${record.nextAction} · ${record.nextActionDate}`)
        ) : (
          <div className="grid grid-cols-[1fr_160px] gap-2">
            <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="e.g. Call back with the price list" aria-label="Next action" aria-invalid={Boolean(shown("nextAction"))} />
            <Input type="date" min={day} value={nextDate} onChange={(e) => setNextDate(e.target.value)} aria-label="Next action date" aria-invalid={Boolean(shown("nextActionDate"))} />
          </div>
        ),
        shown("nextAction") ?? shown("nextActionDate"),
      )}
      {row(
        7,
        "reasonCode",
        "Why is this lead worth following up?",
        false,
        <>
          <Select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full" aria-label="Reason" aria-invalid={Boolean(shown("reasonCode"))}>
            <option value="">Choose a reason…</option>
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
          <Textarea rows={2} className="mt-2" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        </>,
        shown("reasonCode"),
      )}

      {error ? (
        <p role="alert" className="mt-3 mb-0 rounded-[4px] border border-danger bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
