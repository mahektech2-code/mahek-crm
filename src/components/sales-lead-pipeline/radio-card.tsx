import { Card, Input, cx } from "@/components/ui/primitives";
import type { FindingField } from "@/lib/sales-lead-pipeline/engine";
import { salesmanNotesFor } from "@/lib/sales-lead-pipeline/engine";
import type { Lead } from "@/lib/sales-lead-pipeline/types";

/**
 * A bordered, clickable option — the prototype's `.radio-card` pattern used
 * for every reason/option list in its modals (Convert's reasons, Lost's
 * reasons, Ask Order's blockers, Sample Review's trial result, Verify's
 * yes/no pairs). The CRM's own shared `Radio` primitive is a bare input+label
 * with no selected-state styling, which is right for an ordinary form but
 * loses the "pick one of these" affordance the prototype's option lists
 * rely on — this fills that gap using only colors already in the CRM's own
 * palette (`border-brand`, `bg-brand-soft`), not a new one.
 */
export function RadioCard({
  name,
  label,
  checked,
  onChange,
  className,
}: {
  name?: string;
  label: React.ReactNode;
  checked: boolean;
  onChange: () => void;
  className?: string;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-2.5 rounded-[6px] border px-3 py-2.5 text-sm",
        checked ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong",
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-[15px] w-[15px] flex-none accent-[#6835FB]"
      />
      <span className="text-body">{label}</span>
    </label>
  );
}

/* ---------------------------------------------------------------------------
 * The salesman-findings review row: "Salesman entered: <value>" plus
 * Confirm / Correct / Unable To Verify — the exact control the approved
 * workflow uses for every reviewable field (Monthly Requirement, Monthly
 * Potential, Product, Competitor, Contact Person, Decision Maker, Buyer,
 * Trial Interest) at both Prospect Conversion and Manager Verification.
 * ------------------------------------------------------------------------- */

export type FindingChoice = "confirm" | "correct" | "unable";
export type FindingRowState = { choice: FindingChoice; value: string; reason: string };

export function initialFindingState(onFile: string): FindingRowState {
  return { choice: "confirm", value: onFile, reason: "" };
}

export function FindingFieldRow({
  label,
  onFile,
  state,
  onChange,
}: {
  label: string;
  onFile: string;
  state: FindingRowState;
  onChange: (next: FindingRowState) => void;
}) {
  return (
    <div className="mb-3.5" data-finding-field={label}>
      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className="mb-1.5 text-[13px] text-muted">
        Salesman entered: <b className="text-ink">{onFile}</b>
      </div>
      <div className="flex gap-2">
        <RadioCard
          className="flex-1"
          label="Confirm"
          checked={state.choice === "confirm"}
          onChange={() => onChange({ ...state, choice: "confirm" })}
        />
        <RadioCard
          className="flex-1"
          label="Correct"
          checked={state.choice === "correct"}
          onChange={() => onChange({ ...state, choice: "correct" })}
        />
        <RadioCard
          className="flex-1"
          label="Unable To Verify"
          checked={state.choice === "unable"}
          onChange={() => onChange({ ...state, choice: "unable" })}
        />
      </div>
      {state.choice === "correct" ? (
        <div className="mt-2 flex gap-2">
          <Input
            placeholder="Corrected value"
            value={state.value}
            onChange={(e) => onChange({ ...state, value: e.target.value })}
            className="flex-1"
          />
          <Input
            placeholder="Reason for correction"
            value={state.reason}
            onChange={(e) => onChange({ ...state, reason: e.target.value })}
            className="flex-1"
          />
        </div>
      ) : null}
    </div>
  );
}

/** A field with nothing on file yet — the first and only time it's ever asked, exactly as Prospect Conversion treats a genuinely missing finding. */
export function FindingFieldInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-3.5">
      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <Input placeholder="Not Yet Confirmed — enter if known" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** The read-only "Salesman findings" summary card shown at the top of Manager Verification — all 8 facts, plus the salesman's own notes, before anything is reviewed. */
export function SalesmanFindingsCard({ lead, fields }: { lead: Lead; fields: FindingField[] }) {
  const notes = salesmanNotesFor(lead);
  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
        <div className="text-[15px] font-semibold text-ink">Salesman findings</div>
        <span className="rounded-[4px] bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand-hover">
          Collected in the field — verify, don&rsquo;t re-ask
        </span>
      </div>
      <div className="px-5 py-4">
        {fields.map((f) => (
          <div key={f.key} className="flex justify-between gap-3 border-b border-divider py-1.5 text-[13px] last:border-0">
            <span className="text-muted">{f.label}</span>
            <span className="text-right font-medium text-ink">{f.get(lead) || "—"}</span>
          </div>
        ))}
        <div className="flex justify-between gap-3 py-1.5 text-[13px]">
          <span className="text-muted">Salesman notes</span>
          <span className="max-w-[320px] text-left font-medium text-ink">{notes || "—"}</span>
        </div>
      </div>
    </Card>
  );
}
