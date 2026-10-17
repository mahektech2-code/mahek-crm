"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ProductField } from "@/components/products/product-field";
import { Field, Input, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { editLeadBasics } from "@/lib/actions/sales-manager-edit";
import { pipelineLinks } from "@/lib/sales-lead-pipeline/workspace";
import { PCard, PPage, PSectionLabel, pbtn } from "../proto/ui";

/* ---------------------------------------------------------------------------
 * THE SALES MANAGER'S EDIT: owner, sales manager, city, contact, phone and
 * product — and deliberately nothing else. Stage, the other seats, the
 * qualification answers and every other column are not here; they have their
 * own controls on the record.
 *
 * It only DRAWS and sends. What may be changed, by whom, and on whose lead is
 * `editLeadBasics`, which asks the Sales Manager seat again on the server — a
 * form is not a permission.
 * ------------------------------------------------------------------------- */

type Person = { id: string; name: string };

export type EditableLead = {
  id: string;
  name: string;
  ownerId: string;
  managerId: string;
  city: string;
  contact: string;
  phone: string;
  productId: string | null;
  product: string | null;
  lost: boolean;
  canWork: boolean;
};

export function SalesManagerEditForm({
  lead,
  salesmen,
  managers,
}: {
  lead: EditableLead;
  salesmen: Person[];
  managers: Person[];
}) {
  const router = useRouter();
  const toast = useToast();
  const base = pipelineLinks("crm").base;
  const back = `${base}/${lead.id}`;

  const [ownerId, setOwnerId] = React.useState(lead.ownerId);
  const [managerId, setManagerId] = React.useState(lead.managerId);
  const [city, setCity] = React.useState(lead.city);
  const [contact, setContact] = React.useState(lead.contact);
  const [phone, setPhone] = React.useState(lead.phone);
  const [productId, setProductId] = React.useState<string | null>(lead.productId);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const changed =
    ownerId !== lead.ownerId ||
    managerId !== lead.managerId ||
    city.trim() !== lead.city ||
    contact.trim() !== lead.contact ||
    phone.trim() !== lead.phone ||
    productId !== lead.productId;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const r = await editLeadBasics({
      customerId: lead.id,
      ownerId: ownerId || null,
      leadManagerId: managerId || null,
      city,
      contact,
      phone,
      productId,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setFieldErrors(Object.fromEntries((r.fieldErrors ?? []).map((f) => [f.field, f.message])));
      return;
    }
    toast.push(r.message ?? "Saved.");
    router.push(back);
    router.refresh();
  }

  const disabled = busy || !lead.canWork;

  return (
    <PPage narrow>
      <div className="mb-2.5 text-[12.5px] text-muted">
        <Link href={base} className="text-brand">
          Sales Manager desk
        </Link>
        {" / "}
        <Link href={back} className="text-brand">
          {lead.name}
        </Link>
        {" / Edit"}
      </div>

      <form onSubmit={save}>
        <PCard className="mb-4 px-5 py-[18px]">
          <PSectionLabel>Edit {lead.name}</PSectionLabel>

          {!lead.canWork ? (
            <div className="mb-3 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn-ink">
              Your account cannot edit leads here (it needs the lead.work permission).
            </div>
          ) : null}
          {lead.lost ? (
            <div className="mb-3 rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-muted">
              This lead is marked Lost. You can still correct these details; its stage does not change.
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="mb-3 rounded-lg border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-ink">
              {error}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2">
            <Field label="Owner" hint="Only people who hold the Salesman App can own a lead. Both people are told.">
              <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={disabled}>
                {lead.ownerId ? null : <option value="">Nobody yet</option>}
                {salesmen.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Sales manager" hint="The sales manager this lead is coordinated by.">
              <Select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={disabled}>
                {lead.managerId ? null : <option value="">Nobody holds this seat yet</option>}
                {managers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="City" error={fieldErrors.city}>
              <Input value={city} onChange={(e) => setCity(e.target.value)} disabled={disabled} maxLength={120} />
            </Field>

            <Field label="Contact person" error={fieldErrors.contact}>
              <Input value={contact} onChange={(e) => setContact(e.target.value)} disabled={disabled} maxLength={200} />
            </Field>

            <Field label="Phone" hint="A 10-digit mobile number." error={fieldErrors.phone}>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
                disabled={disabled}
                inputMode="numeric"
              />
            </Field>

            <Field label="Product" error={fieldErrors.productId}>
              <ProductField customerId={lead.id} productId={productId} productName={lead.product} disabled={disabled} onPick={setProductId} />
            </Field>
          </div>
        </PCard>

        <div className="flex items-center gap-2">
          <button type="submit" className={pbtn("primary")} disabled={disabled || !changed}>
            {busy ? "Saving…" : "Save changes"}
          </button>
          <Link href={back} className={pbtn("ghost")}>
            Cancel
          </Link>
        </div>
      </form>
    </PPage>
  );
}
