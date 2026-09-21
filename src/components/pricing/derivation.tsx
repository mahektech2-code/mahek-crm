"use client";

/* ---------------------------------------------------------------------------
 * A DERIVED LIST'S RULE — the three fields that state it, and the sentence.
 *
 * Three screens ask for the same rule: creating a list under a parent,
 * deriving one from a list already in force, and revising every rate on a new
 * version. They are three different acts and one rule, so the editor lives
 * here rather than being typed out three times — a rule that drifts between
 * two modals is a rule where the two produce different prices from one number.
 *
 * `derivationSentence` is the other half: the rule said in words, which is how
 * the detail screen introduces a child list. A stored `{kind, paise}` on a
 * screen is a code, and a code on a screen is a bug.
 *
 * MONEY IS PAISE. The rupee box converts at this boundary and nowhere else.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import type { PriceDerivation } from "@/db/schema";
import { deriveRate, inclFromEx, pctLabel } from "@/lib/engines/price-math";
import { money, parseRupees } from "@/lib/format";
import { Field, Input, MoneyInput, Radio } from "@/components/ui/primitives";

export type DerivationDraft = {
  kind: PriceDerivation["kind"];
  /** A rupee string for the two paise kinds; a percent string for the third. */
  amount: string;
};

export const EMPTY_DERIVATION: DerivationDraft = { kind: "per_litre_paise", amount: "" };

/** The draft as the action wants it, or null where nothing usable was typed. */
export function toDerivation(draft: DerivationDraft): PriceDerivation | null {
  if (draft.kind === "percent_bp") {
    const pct = Number(draft.amount);
    if (!draft.amount.trim() || Number.isNaN(pct) || pct === 0) return null;
    return { kind: "percent_bp", bp: Math.round(pct * 100) };
  }
  const negative = draft.amount.trim().startsWith("-");
  const paise = parseRupees(draft.amount.replace("-", ""));
  if (paise == null || paise === 0) return null;
  return { kind: draft.kind, paise: negative ? -paise : paise };
}

export function derivationSentence(derivation: PriceDerivation): string {
  switch (derivation.kind) {
    case "per_litre_paise":
      return `${derivation.paise < 0 ? "−" : "+"}${money(Math.abs(derivation.paise))} a litre`;
    case "per_can_paise":
      return `${derivation.paise < 0 ? "−" : "+"}${money(Math.abs(derivation.paise))} a can`;
    case "percent_bp":
      return `${derivation.bp < 0 ? "−" : "+"}${pctLabel(Math.abs(derivation.bp))}`;
  }
}

/** A 20 litre can at the sample rate, before and after — so a number has a consequence. */
export function derivationExample(
  draft: DerivationDraft,
  sample: { name: string; exPaise: number; millilitresPerCan: number | null },
  gstBp: number,
): string | null {
  const derivation = toDerivation(draft);
  if (!derivation) return null;
  const moved = deriveRate(sample.exPaise, sample.millilitresPerCan, derivation);
  if (moved == null) return null;
  return `${sample.name} at ${money(inclFromEx(sample.exPaise, gstBp))} becomes ${money(
    inclFromEx(moved, gstBp),
  )}.`;
}

export function DerivationFields({
  draft,
  onChange,
  example,
  error,
}: {
  draft: DerivationDraft;
  onChange: (next: DerivationDraft) => void;
  /** The live worked example, where the caller has a rate to work it on. */
  example?: string | null;
  error?: string | null;
}) {
  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          The rule
        </span>
        <div className="space-y-1.5">
          <Radio
            name="derivation-kind"
            checked={draft.kind === "per_litre_paise"}
            onChange={() => onChange({ ...draft, kind: "per_litre_paise" })}
            label="Per litre — freight, so a 20 L can moves twenty times what a 1 L can does"
          />
          <Radio
            name="derivation-kind"
            checked={draft.kind === "percent_bp"}
            onChange={() => onChange({ ...draft, kind: "percent_bp" })}
            label="A percentage — a margin, or a revision across the board"
          />
          <Radio
            name="derivation-kind"
            checked={draft.kind === "per_can_paise"}
            onChange={() => onChange({ ...draft, kind: "per_can_paise" })}
            label="Per can — a flat premium, whatever the pack size"
          />
        </div>
      </div>

      {draft.kind === "percent_bp" ? (
        <Field
          label="Percent"
          error={error ?? null}
          hint="Minus for a reduction, so −2.5 takes two and a half percent off."
        >
          <Input
            value={draft.amount}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
            placeholder="e.g. 5"
            inputMode="decimal"
          />
        </Field>
      ) : (
        <Field
          label={draft.kind === "per_litre_paise" ? "Rupees a litre" : "Rupees a can"}
          error={error ?? null}
          hint="Put a minus in front of it to take money off."
        >
          <MoneyInput
            value={draft.amount}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
            placeholder="e.g. 10.17"
          />
        </Field>
      )}

      {example ? (
        <p className="rounded-[4px] bg-canvas px-3 py-2 text-[13px] text-body">
          {example}
        </p>
      ) : null}
    </div>
  );
}
