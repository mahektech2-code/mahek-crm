"use client";

/* ---------------------------------------------------------------------------
 * CORRECTING WHAT A CELL SAYS THE PRICE IS.
 *
 * A scan reads 1,168 as 1,l68 often enough that this has to exist, and the one
 * thing it must not do is ask which number is which. The document is printed
 * one way — these lists are GST inclusive — so the figure typed here is the
 * inclusive one and the ex-GST figure is shown LIVE beside it, derived by
 * `exFromIncl` from the header's own rate. Two boxes would be two answers to
 * one question and the wrong one would be stored half the time.
 *
 * "Not offered on this list" is the other real answer. A blank cell in a grid
 * is usually a pack size the list does not sell, and recording that as a price
 * of zero would put a free product on an order form.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox, Field, MoneyInput } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { setParseRowPrice } from "@/lib/actions/price-lists";
import { exFromIncl } from "@/lib/engines/price-math";
import { money, parseRupees, rupeesFromPaise } from "@/lib/format";
import type { ParseRowView } from "@/lib/price-list-views";

export function ParsePriceModal({
  open,
  onClose,
  cell,
  gstBp,
}: {
  open: boolean;
  onClose: () => void;
  cell: ParseRowView | null;
  /** The document header's GST rate, so the ex-GST figure matches what publishing will write. */
  gstBp: number;
}) {
  if (!open || !cell) return null;
  return <Body key={cell.id} onClose={onClose} cell={cell} gstBp={gstBp} />;
}

function Body({
  onClose,
  cell,
  gstBp,
}: {
  onClose: () => void;
  cell: ParseRowView;
  gstBp: number;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [rupees, setRupees] = React.useState(
    cell.rateInclGstPaise !== null ? rupeesFromPaise(cell.rateInclGstPaise) : "",
  );
  const [notOffered, setNotOffered] = React.useState(!cell.offered);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const paise = parseRupees(rupees);

  async function save() {
    if (!notOffered && (paise === null || paise <= 0)) {
      setErrors({ rateInclGstPaise: "Type the price as the document prints it, or say it is not offered." });
      return;
    }
    setBusy(true);
    try {
      const result = await run(
        setParseRowPrice({
          rowId: cell.id,
          rateInclGstPaise: notOffered ? null : paise,
          offered: !notOffered,
        }),
      );
      if (result.ok) {
        onClose();
        router.refresh();
      } else if (result.fieldErrors) {
        setErrors(Object.fromEntries(result.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Correct this price"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="mb-4 rounded-[4px] border border-line bg-canvas px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          As the document has it
        </div>
        <div className="mt-1 text-sm font-medium text-ink">{cell.rawProductText}</div>
        <div className="mt-0.5 text-[13px] text-muted">
          {[cell.rawPackText, cell.rawPriceText].filter(Boolean).join(" · ") || "Nothing legible in this cell."}
        </div>
      </div>

      <Field
        label="Price as printed"
        hint="These lists print the inclusive figure. The ex-GST rate is worked out from it."
        error={errors.rateInclGstPaise ?? null}
      >
        <MoneyInput
          value={rupees}
          disabled={notOffered}
          invalid={!!errors.rateInclGstPaise}
          onChange={(e) => setRupees(e.target.value)}
          placeholder="1168"
        />
      </Field>

      <div className="mt-2 text-[13px] text-muted">
        {notOffered
          ? "Nothing will be written for this cell."
          : paise && paise > 0
            ? `${money(paise)} including GST · ${money(exFromIncl(paise, gstBp))} before GST at ${(gstBp / 100).toFixed(0)}%`
            : "Type a figure to see the ex-GST rate."}
      </div>

      <div className="mt-4 border-t border-divider pt-3">
        <Checkbox
          label="Not offered on this list"
          checked={notOffered}
          onChange={(e) => setNotOffered(e.target.checked)}
        />
        <p className="mt-1 text-[11px] text-muted">
          A blank cell in a grid is usually a pack size this list does not sell. Saying so is not the same as a
          price of nothing.
        </p>
      </div>
    </Modal>
  );
}
