"use client";

import { Field, Input, Select } from "@/components/ui/primitives";
import { longDate } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * How the money came, and what names it.
 *
 * One component because it was three: the collections worklist, the bills
 * ledger and the call panel each asked the same three questions, each with its
 * own copy of the mode list written out as a literal — so adding `Credit note`
 * reached the accounts app and none of them, and adding a cheque date would
 * have had to be got right three times.
 *
 * The list comes from `payments.modes`, which is configuration and always was.
 * A list of modes typed into a screen is the same mistake as a product list
 * typed into a screen.
 * ------------------------------------------------------------------------- */

export function PaymentModeFields({
  modes,
  datedModes,
  today,
  mode,
  onMode,
  reference,
  onReference,
  instrumentDate,
  onInstrumentDate,
  error,
  referenceError,
}: {
  modes: string[];
  /** Modes whose instrument carries a date of its own — `payments.datedModes`. */
  datedModes: string[];
  today: string;
  mode: string;
  onMode: (v: string) => void;
  reference: string;
  onReference: (v: string) => void;
  instrumentDate: string;
  onInstrumentDate: (v: string) => void;
  /** What the server said about the instrument date, shown against it. */
  error?: string;
  /** And about the reference. A message under the wrong field sends somebody
   *  to fix what is not broken. */
  referenceError?: string;
}) {
  const dated = datedModes.includes(mode);
  const postDated = Boolean(instrumentDate && instrumentDate > today);

  return (
    <>
      <Field label="Mode">
        <Select
          className="w-full"
          value={mode}
          onChange={(e) => {
            onMode(e.target.value);
            // A cheque date belongs to a cheque. Carried over to Cash it would
            // be sent against a mode that has no date, which the service
            // refuses — and rightly, since it would mean nothing.
            onInstrumentDate("");
          }}
        >
          {modes.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
      </Field>

      <Field
        label="Reference"
        error={referenceError}
        hint={referenceError ? undefined : "UTR, cheque number - optional"}
      >
        <Input
          value={reference}
          onChange={(e) => onReference(e.target.value)}
          placeholder="UTR or cheque number"
        />
      </Field>

      {/*
        The date written ON the cheque, which is not the day it was handed
        over. A cheque given today and dated the 20th cannot be banked until
        the 20th, and the two answer different questions.

        Asked of the telecaller too, unlike the reference: a customer who says
        they have paid by cheque is holding the cheque while they speak, so
        "what date is on it" is a question that can be asked on the same call.
      */}
      {dated ? (
        <Field
          className="col-span-2"
          label={`${mode} date`}
          error={error}
          hint={
            error
              ? undefined
              : postDated
                ? `Post-dated — it cannot be banked until ${longDate(instrumentDate)}, and they will not be chased for it until then.`
                : "The date on it, not the day it was handed over. Past or future are both fine."
          }
        >
          <Input
            type="date"
            value={instrumentDate}
            onChange={(e) => onInstrumentDate(e.target.value)}
          />
        </Field>
      ) : null}
    </>
  );
}
