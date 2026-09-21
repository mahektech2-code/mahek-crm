"use client";

/* ---------------------------------------------------------------------------
 * PUTTING ONE SHOP ON ONE LIST, BY NAME.
 *
 * A named customer beats every other scope — it is the narrowest rung of the
 * resolution ladder — so this is the override, used where a shop's own
 * geography would otherwise price it from the wrong sheet. It is a scope row
 * like any other and not a column on the customer, which is why the action
 * clears whatever customer scope that shop already had: a shop named by two
 * lists leaves the answer to a priority nobody would think to look at.
 *
 * "None" is a real answer and the way back: the shop falls through to
 * whichever list its area, its salesman or everybody is on. Saying so in words
 * matters, because a blank select reads as nothing happening.
 *
 * The freight term is asked here too, because it is the other half of which
 * list applies — "Odisha Paid" and "Odisha To Pay" are one region and two
 * answers — and it is a fact about the shop rather than about the list.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Field, Select } from "@/components/ui/primitives";
import type { PricingOptions } from "@/lib/price-list-views";
import { FREIGHT_TERM_HINT, FREIGHT_TERM_LABEL, LIST_STATUS_LABEL } from "@/lib/price-list-labels";
import { assignCustomerList } from "@/lib/actions/price-lists";

export function AssignCustomerListModal(props: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string;
  lists: PricingOptions["lists"];
  currentListId: string | null;
}) {
  if (!props.open) return null;
  return <AssignBody key={props.customerId} {...props} />;
}

function AssignBody({
  onClose,
  customerId,
  customerName,
  lists,
  currentListId,
}: {
  onClose: () => void;
  customerId: string;
  customerName: string;
  lists: PricingOptions["lists"];
  currentListId: string | null;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [listId, setListId] = React.useState(currentListId ?? "");
  /* Empty means "leave the shop's own term alone" — which is not the same as
     clearing it, so the action is only told when somebody picks one. */
  const [freightTerm, setFreightTerm] = React.useState<"" | "to_pay" | "paid">("");

  /* Only a published list prices anything, so only published lists are
     offered. A draft in the picker is a shop priced from nothing. */
  const offered = lists.filter((l) => l.status === "published" || l.id === currentListId);

  async function save() {
    setBusy(true);
    try {
      const r = await run(
        assignCustomerList({
          customerId,
          priceListId: listId || null,
          ...(freightTerm ? { freightTerm } : {}),
        }),
      );
      if (r.ok) {
        onClose();
        router.refresh();
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
      width={520}
      title={`Which list prices ${customerName}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save} title={busy ? "Saving…" : undefined}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <p className="max-w-[720px] text-[13px] text-muted">
          Naming a shop beats every other rule — its city, its salesman and the
          list everybody is on. Use it where the geography prices it wrongly,
          not as the ordinary way a shop gets a price.
        </p>

        <Field
          label="Price list"
          error={errors.priceListId ?? null}
          hint="None sends them back to whichever list their area or salesman is on."
        >
          <Select value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">None — let the rules decide</option>
            {offered.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.status === "published" ? "" : ` (${LIST_STATUS_LABEL[l.status]})`}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Who pays the transport"
          error={errors.freightTerm ?? null}
          hint={freightTerm ? FREIGHT_TERM_HINT[freightTerm] : "Leave it alone unless it is wrong on the shop."}
        >
          <Select
            value={freightTerm}
            onChange={(e) => setFreightTerm(e.target.value as "" | "to_pay" | "paid")}
          >
            <option value="">Leave it as it is</option>
            <option value="to_pay">{FREIGHT_TERM_LABEL.to_pay}</option>
            <option value="paid">{FREIGHT_TERM_LABEL.paid}</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
