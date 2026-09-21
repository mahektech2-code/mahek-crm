"use client";

/* ---------------------------------------------------------------------------
 * A LIST BUILT ON THIS ONE — the same prices plus a rule.
 *
 * Most of Mahek's lists are one list and an arithmetic: the Odisha pair is the
 * Mumbai sheet plus freight a litre, the tin-can sheet is the same liquid plus
 * a flat premium a can. Recording it as a DERIVATION rather than as two
 * hundred retyped figures is what makes the next price rise one change instead
 * of five, and it is what lets `publishPriceList` say, later, which rates have
 * drifted off the rule they claim to follow.
 *
 * It starts a DRAFT. The rates come across worked out and nothing is priced
 * from it until somebody publishes it.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { PRICE_FREIGHT_TERMS } from "@/db/schema";
import type { PriceListDetail } from "@/lib/price-list-views";
import { FREIGHT_TERM_HINT, FREIGHT_TERM_LABEL } from "@/lib/price-list-labels";
import { createDerivedList } from "@/lib/actions/price-lists";
import {
  DerivationFields,
  EMPTY_DERIVATION,
  derivationExample,
  toDerivation,
  type DerivationDraft,
} from "@/components/pricing/derivation";

const DATE_CLASS =
  "h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

export function DerivedListModal(props: {
  open: boolean;
  onClose: () => void;
  detail: PriceListDetail;
  todayIso: string;
  basePath: string;
}) {
  if (!props.open) return null;
  return <DerivedBody key={props.detail.list.id} {...props} />;
}

function DerivedBody({
  onClose,
  detail,
  todayIso,
  basePath,
}: {
  onClose: () => void;
  detail: PriceListDetail;
  todayIso: string;
  basePath: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const [name, setName] = React.useState(`${detail.list.name} — derived`);
  const [refNo, setRefNo] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso);
  const [freightTerm, setFreightTerm] = React.useState<(typeof PRICE_FREIGHT_TERMS)[number]>(
    detail.list.freightTerm,
  );
  const [draft, setDraft] = React.useState<DerivationDraft>(EMPTY_DERIVATION);

  /* The example is worked on a real rate off THIS list — the biggest pack, so
     a per-litre rule shows its largest consequence rather than its smallest. */
  const sample = React.useMemo(() => {
    const priced = detail.rates.filter((r) => r.millilitresPerCan != null);
    const biggest = priced.sort((a, b) => (b.millilitresPerCan ?? 0) - (a.millilitresPerCan ?? 0))[0];
    return biggest
      ? {
          name: biggest.productName,
          exPaise: biggest.rateExGstPaise,
          millilitresPerCan: biggest.millilitresPerCan,
        }
      : null;
  }, [detail.rates]);

  const example = sample ? derivationExample(draft, sample, detail.list.gstBp) : null;

  async function save() {
    const derivation = toDerivation(draft);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "A list needs a name people will recognise.";
    if (!derivation) next.derivation = "Say how this list is worked out from its parent.";
    setErrors(next);
    if (Object.keys(next).length || !derivation) return;

    setBusy(true);
    try {
      const r = await run(
        createDerivedList({
          name: name.trim(),
          refNo: refNo.trim() || null,
          effectiveFrom,
          taxBasis: detail.list.taxBasis,
          gstBp: detail.list.gstBp,
          deliveryBasis: detail.list.deliveryBasis,
          freightTerm,
          termsText: detail.list.termsText,
          signatory: detail.list.signatory,
          parentListId: detail.list.id,
          derivation,
        }),
      );
      if (r.ok) {
        onClose();
        router.push(`${basePath}/${r.data.id}`);
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={`A list derived from ${detail.list.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save} title={busy ? "Working…" : undefined}>
            {busy ? "Working…" : "Make the draft"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" error={errors.name ?? null}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Reference number" error={errors.refNo ?? null}>
            <Input value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Effective from" error={errors.effectiveFrom ?? null}>
            <input
              type="date"
              className={DATE_CLASS}
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
          <Field label="Freight term" hint={FREIGHT_TERM_HINT[freightTerm]}>
            <Select
              value={freightTerm}
              onChange={(e) => setFreightTerm(e.target.value as (typeof PRICE_FREIGHT_TERMS)[number])}
            >
              {PRICE_FREIGHT_TERMS.map((t) => (
                <option key={t} value={t}>
                  {FREIGHT_TERM_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <DerivationFields draft={draft} onChange={setDraft} example={example} error={errors.derivation ?? null} />
      </div>
    </Modal>
  );
}
