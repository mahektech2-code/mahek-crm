"use client";

/* ---------------------------------------------------------------------------
 * A PRICE REVISION — every rate on a list, moved by one rule.
 *
 * This is what a price rise actually is: not two hundred typed figures but one
 * sentence, "everything up 5%", or "freight to Odisha is 10.17 a litre now".
 * It makes a NEW VERSION and moves the rates on that, never on the list in
 * force, because orders have been taken at the old figures.
 *
 * THE SAMPLE IS SHOWN TWICE, DELIBERATELY. Before the button it is computed
 * here, with the same `deriveRate` the server runs, over the rates already on
 * the screen — so a person sees what a number does before spending it. After
 * it, the sample that comes BACK from the action is what was actually written,
 * and that is the one that is true. A preview is not evidence; it is a reason
 * to press the button.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Callout, Checkbox, Field, Td, Th, Tr } from "@/components/ui/primitives";
import type { PriceListDetail } from "@/lib/price-list-views";
import { bulkRevise } from "@/lib/actions/price-lists";
import { deriveRate, inclFromEx, roundToRupee } from "@/lib/engines/price-math";
import { money } from "@/lib/format";
import {
  DerivationFields,
  EMPTY_DERIVATION,
  toDerivation,
  type DerivationDraft,
} from "@/components/pricing/derivation";

const DATE_CLASS =
  "h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

export function BulkReviseModal(props: {
  open: boolean;
  onClose: () => void;
  detail: PriceListDetail;
  todayIso: string;
  basePath: string;
}) {
  if (!props.open) return null;
  return <ReviseBody key={props.detail.list.id} {...props} />;
}

function ReviseBody({
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
  const [draft, setDraft] = React.useState<DerivationDraft>(EMPTY_DERIVATION);
  const [round, setRound] = React.useState(true);
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso);
  const [written, setWritten] = React.useState<Array<{ productName: string; fromEx: number; toEx: number }> | null>(
    null,
  );
  const [newId, setNewId] = React.useState<string | null>(null);

  const gstBp = detail.list.gstBp;
  const derivation = toDerivation(draft);

  /* Five rows, the same arithmetic the server will run. */
  const preview = React.useMemo(() => {
    if (!derivation) return [];
    return detail.rates
      .slice(0, 5)
      .map((r) => {
        const moved = deriveRate(r.rateExGstPaise, r.millilitresPerCan, derivation);
        if (moved == null) return null;
        return {
          productName: r.productName,
          fromEx: r.rateExGstPaise,
          toEx: round ? roundToRupee(moved) : moved,
        };
      })
      .filter((r): r is { productName: string; fromEx: number; toEx: number } => r !== null);
  }, [detail.rates, derivation, round]);

  async function save() {
    if (!derivation) {
      setErrors({ derivation: "Say how much everything moves by." });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setErrors({ effectiveFrom: "Say when the revision comes into force." });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await run(bulkRevise(detail.list.id, { derivation, effectiveFrom, roundToRupee: round }));
      if (r.ok) {
        setWritten(r.data.sample);
        setNewId(r.data.id);
        router.refresh();
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  if (written && newId) {
    return (
      <Modal
        open
        onClose={onClose}
        width={560}
        title="Every rate has been moved"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Stay here
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                router.push(`${basePath}/${newId}`);
              }}
            >
              Open the draft
            </Button>
          </>
        }
      >
        <Callout tone="brand">
          It is a DRAFT. Check the figures, then publish it — nothing is priced
          from it until you do.
        </Callout>
        <SampleTable rows={written} gstBp={gstBp} />
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={`Revise every price on ${detail.list.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !derivation}
            title={!derivation ? "Say how much everything moves by." : busy ? "Working…" : undefined}
            onClick={save}
          >
            {busy ? "Working…" : "Make the revised draft"}
          </Button>
        </>
      }
    >
      <p className="mb-3.5 max-w-[720px] text-[13px] text-muted">
        This makes a new version of {detail.list.name} and moves all{" "}
        {detail.rates.length} of its prices by one rule. The list in force is not
        touched.
      </p>
      <div className="space-y-3.5">
        <DerivationFields draft={draft} onChange={setDraft} error={errors.derivation ?? null} />

        <Checkbox
          checked={round}
          onChange={(e) => setRound(e.target.checked)}
          label="Round every price to the rupee — which is how the office prints them"
        />

        <Field label="Effective from" error={errors.effectiveFrom ?? null}>
          <input
            type="date"
            className={DATE_CLASS}
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </Field>

        {preview.length ? (
          <div>
            <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
              What it would do
            </div>
            <SampleTable rows={preview} gstBp={gstBp} />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function SampleTable({
  rows,
  gstBp,
}: {
  rows: Array<{ productName: string; fromEx: number; toEx: number }>;
  gstBp: number;
}) {
  return (
    <div className="overflow-auto rounded-[4px] border border-line">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Product</Th>
            <Th align="right">Now</Th>
            <Th align="right">Becomes</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.productName}>
              <Td className="max-w-[260px] truncate" title={r.productName}>
                {r.productName}
              </Td>
              <Td align="right">{money(inclFromEx(r.fromEx, gstBp))}</Td>
              <Td align="right" className="font-medium text-ink">
                {money(inclFromEx(r.toEx, gstBp))}
              </Td>
            </Tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
