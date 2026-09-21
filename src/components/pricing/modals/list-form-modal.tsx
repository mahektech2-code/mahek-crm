"use client";

/* ---------------------------------------------------------------------------
 * A PRICE LIST'S OWN FACTS — created, or corrected.
 *
 * One modal for both, because they are one form: what the list is called, when
 * it comes into force, what the GST basis is, who pays the transport, and the
 * terms printed under it. A second "edit" dialog would be a second answer to
 * which of those a person may change.
 *
 * WHAT A PUBLISHED LIST WILL NOT LET YOU TOUCH is the point of the branch
 * below. A list in force has been quoted to shops: moving its effective date,
 * its GST or its freight term silently reprices every order taken against it.
 * Those controls are disabled and each carries a `title` saying so, and the way
 * forward — a new version — is named in the dialog rather than left to be
 * guessed at. The wording, the terms and the notes are still editable, because
 * correcting a typo in a sentence moves no money.
 *
 * MONEY IS PAISE. The rupee boxes convert at this boundary with `parseRupees`.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Callout, Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/primitives";
import { PRICE_DELIVERY_BASES, PRICE_FREIGHT_TERMS } from "@/db/schema";
import type { PriceListDetail, PricingOptions } from "@/lib/price-list-views";
import { DELIVERY_BASIS_LABEL, FREIGHT_TERM_HINT, FREIGHT_TERM_LABEL } from "@/lib/price-list-labels";
import { createPriceList, updatePriceList } from "@/lib/actions/price-lists";
import { money, parseRupees, rupeesFromPaise } from "@/lib/format";
import {
  DerivationFields,
  EMPTY_DERIVATION,
  toDerivation,
  type DerivationDraft,
} from "@/components/pricing/derivation";
import { deriveRate, inclFromEx } from "@/lib/engines/price-math";

type ListShape = PriceListDetail["list"];

const DATE_CLASS =
  "h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

export function ListFormModal(props: {
  open: boolean;
  onClose: () => void;
  /** Null creates. A list edits it. */
  list: ListShape | null;
  options: PricingOptions;
  todayIso: string;
  basePath: string;
}) {
  if (!props.open) return null;
  // A `key` off the subject, so every open starts from the props rather than
  // from state an effect had to reset — see the React Compiler note in AGENTS.
  return <ListFormBody key={props.list?.id ?? "new"} {...props} />;
}

function ListFormBody({
  onClose,
  list,
  options,
  todayIso,
  basePath,
}: {
  open: boolean;
  onClose: () => void;
  list: ListShape | null;
  options: PricingOptions;
  todayIso: string;
  basePath: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const editing = list !== null;
  const locked = list?.status === "published" || list?.status === "superseded" || list?.status === "withdrawn";
  const lockedWhy = locked
    ? `This list is ${list.status}. Changing what it costs would reprice orders already taken against it — publish a new version instead.`
    : undefined;

  const [name, setName] = React.useState(list?.name ?? "");
  const [refNo, setRefNo] = React.useState(list?.refNo ?? "");
  const [effectiveFrom, setEffectiveFrom] = React.useState(list?.effectiveFrom ?? todayIso);
  const [validityDays, setValidityDays] = React.useState(
    list?.validityDays != null ? String(list.validityDays) : "",
  );
  const [taxBasis, setTaxBasis] = React.useState<"inclusive" | "exclusive">(list?.taxBasis ?? "inclusive");
  const [gstPct, setGstPct] = React.useState(String((list?.gstBp ?? 1800) / 100));
  const [deliveryBasis, setDeliveryBasis] = React.useState(list?.deliveryBasis ?? "");
  const [freightTerm, setFreightTerm] = React.useState(list?.freightTerm ?? "not_stated");
  const [freightPerLitre, setFreightPerLitre] = React.useState(
    list?.freightPerLitrePaise != null ? rupeesFromPaise(list.freightPerLitrePaise) : "",
  );
  const [signatory, setSignatory] = React.useState(list?.signatory ?? "");
  const [notes, setNotes] = React.useState(list?.notes ?? "");
  const [termsText, setTermsText] = React.useState(list?.termsText ?? "");

  /* Only on create: what this list is built on top of. */
  const [parentListId, setParentListId] = React.useState("");
  const [derivation, setDerivation] = React.useState<DerivationDraft>(EMPTY_DERIVATION);
  const [copyFrom, setCopyFrom] = React.useState("");

  const gstBp = Math.round(Number(gstPct || "0") * 100);

  /* A worked example, so a rule typed in has a consequence somebody can read.
     The sample is a 20 litre can at the price the August list printed, which
     is the figure everybody in the office recognises. */
  const sampleExPaise = 193_390;
  const derived = toDerivation(derivation);
  const example =
    derived && Number.isFinite(gstBp)
      ? (() => {
          const moved = deriveRate(sampleExPaise, 20_000, derived);
          if (moved == null) return null;
          return `A 20 L can at ${money(inclFromEx(sampleExPaise, gstBp))} becomes ${money(
            inclFromEx(moved, gstBp),
          )}.`;
        })()
      : null;

  async function save() {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "A list needs a name people will recognise.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) next.effectiveFrom = "Say when it comes into force.";
    if (!Number.isInteger(gstBp) || gstBp < 0) next.gstBp = "GST is a percentage.";
    if (parentListId && !derived) next.derivation = "Say how this list is worked out from its parent.";
    setErrors(next);
    if (Object.keys(next).length) return;

    const fields = {
      name: name.trim(),
      refNo: refNo.trim() || null,
      effectiveFrom,
      validityDays: validityDays.trim() ? Number(validityDays) : null,
      taxBasis,
      gstBp,
      deliveryBasis: (deliveryBasis || null) as (typeof PRICE_DELIVERY_BASES)[number] | null,
      freightTerm,
      freightPerLitrePaise: freightPerLitre.trim() ? parseRupees(freightPerLitre) : null,
      notes: notes.trim() || null,
      termsText: termsText.trim() || null,
      signatory: signatory.trim() || null,
    };

    setBusy(true);
    try {
      if (editing) {
        const r = await run(updatePriceList(list.id, fields));
        if (r.ok) {
          onClose();
          router.refresh();
        } else if (r.fieldErrors) {
          setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
        }
      } else {
        const r = await run(
          createPriceList({
            ...fields,
            parentListId: parentListId || null,
            derivation: parentListId ? derived : null,
            copyRatesFromListId: copyFrom || null,
          }),
        );
        if (r.ok) {
          onClose();
          router.push(`${basePath}/${r.data.id}`);
        } else if (r.fieldErrors) {
          setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title={editing ? `Edit ${list.name}` : "A new price list"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save} title={busy ? "Saving…" : undefined}>
            {busy ? "Saving…" : editing ? "Save" : "Create the draft"}
          </Button>
        </>
      }
    >
      {locked ? <Callout tone="warn">{lockedWhy}</Callout> : null}

      <div className="space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" error={errors.name ?? null} hint="What people in the office call it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="MP & CG — August 2026" />
          </Field>
          <Field label="Reference number" error={errors.refNo ?? null} hint="As printed on the sheet.">
            <Input value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="PL0105" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Effective from" error={errors.effectiveFrom ?? null}>
            <input
              type="date"
              className={DATE_CLASS}
              value={effectiveFrom}
              disabled={locked}
              title={locked ? lockedWhy : undefined}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
          <Field
            label="Valid for (days)"
            error={errors.validityDays ?? null}
            hint="Blank falls back to the configured default."
          >
            <Input
              value={validityDays}
              inputMode="numeric"
              onChange={(e) => setValidityDays(e.target.value)}
              placeholder="30"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Prices are" error={errors.taxBasis ?? null}>
            <Select
              value={taxBasis}
              disabled={locked}
              title={locked ? lockedWhy : undefined}
              onChange={(e) => setTaxBasis(e.target.value as "inclusive" | "exclusive")}
            >
              <option value="inclusive">GST inclusive</option>
              <option value="exclusive">GST extra</option>
            </Select>
          </Field>
          <Field label="GST %" error={errors.gstBp ?? null}>
            <Input
              value={gstPct}
              inputMode="decimal"
              disabled={locked}
              title={locked ? lockedWhy : undefined}
              onChange={(e) => setGstPct(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Delivery basis" error={errors.deliveryBasis ?? null}>
            <Select value={deliveryBasis} onChange={(e) => setDeliveryBasis(e.target.value)}>
              <option value="">Not stated</option>
              {PRICE_DELIVERY_BASES.map((b) => (
                <option key={b} value={b}>
                  {DELIVERY_BASIS_LABEL[b]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Freight term"
            error={errors.freightTerm ?? null}
            hint={FREIGHT_TERM_HINT[freightTerm]}
          >
            <Select
              value={freightTerm}
              disabled={locked}
              title={locked ? lockedWhy : undefined}
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

        <Field
          label="Freight a litre"
          error={errors.freightPerLitrePaise ?? null}
          hint="Where the list states one. Blank is fine."
        >
          <MoneyInput
            value={freightPerLitre}
            disabled={locked}
            title={locked ? lockedWhy : undefined}
            onChange={(e) => setFreightPerLitre(e.target.value)}
            placeholder="10.17"
          />
        </Field>

        {editing ? null : (
          <div className="rounded-[4px] border border-line p-3.5">
            <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Built on another list
            </div>
            <p className="mb-3 max-w-[720px] text-[13px] text-muted">
              Most lists are one list plus a rule — freight to a state, a margin, a
              container premium. Say which list and which rule, and the rates come
              across worked out. Leave it blank for a list of its own.
            </p>
            <Field label="Parent list" error={errors.parentListId ?? null}>
              <Select value={parentListId} onChange={(e) => setParentListId(e.target.value)}>
                <option value="">None — this list stands on its own</option>
                {options.lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            {parentListId ? (
              <div className="mt-3">
                <DerivationFields
                  draft={derivation}
                  onChange={setDerivation}
                  example={example}
                  error={errors.derivation ?? null}
                />
              </div>
            ) : null}
            <div className="mt-3">
              <Field
                label="Copy rates from"
                hint="Starts the draft with somebody else's prices rather than an empty grid."
              >
                <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                  <option value="">Start empty</option>
                  {options.lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        )}

        <Field label="Signatory" error={errors.signatory ?? null} hint="Printed at the foot of the sheet.">
          <Input value={signatory} onChange={(e) => setSignatory(e.target.value)} placeholder="Heena Doshi" />
        </Field>

        <Field label="Terms & conditions" error={errors.termsText ?? null} hint="Printed under the prices, exactly as typed.">
          <Textarea rows={6} value={termsText} onChange={(e) => setTermsText(e.target.value)} />
        </Field>

        <Field label="Notes" error={errors.notes ?? null} hint="For the office. Never printed.">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
