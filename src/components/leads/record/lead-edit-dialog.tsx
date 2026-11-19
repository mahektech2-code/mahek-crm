"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ProductField } from "@/components/products/product-field";
import { Modal } from "@/components/ui/modal";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { editLeadBasics, loadLeadEditForm, type LeadEditForm } from "@/lib/actions/sales-manager-edit";

/* ---------------------------------------------------------------------------
 * EDIT A LEAD — one modal, wherever the lead is open: the CRM record, the
 * Sales Dashboard's, the pipeline and the Sales Manager desk.
 *
 * It was a separate page that only the CRM Sales Manager could reach, so the
 * lead's own salesman or telecaller could not fix a misspelt shop name, and
 * the pipeline's Edit button led back to the record it was on.
 *
 * It only DRAWS and sends. What it opens with, and whether the owner and
 * sales manager boxes appear, is `loadLeadEditForm`; what may be saved is
 * `editLeadBasics`. Both ask `lead.work` and the lead's scope again — a
 * button is not a permission. Stage, qualification answers and every other
 * column have their own controls on the record and are not here.
 * ------------------------------------------------------------------------- */

/** The button and the modal it opens. Draw it only for somebody holding `lead.work`. */
export function EditLeadButton({
  customerId,
  renderButton,
}: {
  customerId: string;
  /** The way in, styled for the screen it sits on. Defaults to a small secondary button. */
  renderButton?: (open: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [round, setRound] = React.useState(0);
  const show = () => {
    setRound((n) => n + 1);
    setOpen(true);
  };
  return (
    <>
      {renderButton ? (
        renderButton(show)
      ) : (
        <Button size="sm" variant="secondary" title="Correct this lead's name, contact, city, phone and product." onClick={show}>
          Edit details
        </Button>
      )}
      {open ? <LeadEditDialog key={round} customerId={customerId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; form: LeadEditForm };

function LeadEditDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const [loaded, setLoaded] = React.useState<Loaded>({ state: "loading" });

  React.useEffect(() => {
    let alive = true;
    loadLeadEditForm(customerId).then(
      (r) => alive && setLoaded(r.ok ? { state: "ready", form: r.data } : { state: "error", message: r.error }),
      () => alive && setLoaded({ state: "error", message: "Could not open the lead. Try again." }),
    );
    return () => {
      alive = false;
    };
  }, [customerId]);

  if (loaded.state !== "ready") {
    return (
      <Modal open onClose={onClose} title="Edit lead" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <p className={loaded.state === "error" ? "text-sm text-danger" : "text-sm text-muted"}>
          {loaded.state === "error" ? loaded.message : "Opening the lead…"}
        </p>
      </Modal>
    );
  }
  return <LeadEditFormBody form={loaded.form} onClose={onClose} />;
}

function LeadEditFormBody({ form, onClose }: { form: LeadEditForm; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { lead, seats } = form;

  const [name, setName] = React.useState(lead.name);
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
    name.trim() !== lead.name ||
    ownerId !== lead.ownerId ||
    managerId !== lead.managerId ||
    city.trim() !== lead.city ||
    contact.trim() !== lead.contact ||
    phone.trim() !== lead.phone ||
    productId !== lead.productId;

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const r = await editLeadBasics({
      customerId: lead.id,
      name,
      /* Seats are sent only where they were offered; elsewhere they stay as they are. */
      ownerId: seats ? ownerId || null : null,
      leadManagerId: seats ? managerId || null : null,
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
    router.refresh();
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={`Edit ${lead.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !changed} title={changed ? undefined : "Nothing has changed yet."}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <form onSubmit={save}>
        {lead.lost ? (
          <p className="mb-3 rounded-control border border-line bg-canvas px-3 py-2 text-[13px] text-muted">
            This lead is marked Lost. You can still correct these details; its stage does not change.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-3 rounded-control border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <Field label="Lead name" error={fieldErrors.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={200} />
            </Field>
          </div>

          {seats ? (
            <>
              <Field label="Owner" hint="Only people who hold the Salesman App can own a lead. Both people are told.">
                <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={busy}>
                  {lead.ownerId ? null : <option value="">Nobody yet</option>}
                  {seats.salesmen.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sales manager" hint="The sales manager this lead is coordinated by.">
                <Select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={busy}>
                  {lead.managerId ? null : <option value="">Nobody holds this seat yet</option>}
                  {seats.managers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}

          <Field label="City" error={fieldErrors.city}>
            <Input value={city} onChange={(e) => setCity(e.target.value)} disabled={busy} maxLength={120} />
          </Field>

          <Field label="Contact person" error={fieldErrors.contact}>
            <Input value={contact} onChange={(e) => setContact(e.target.value)} disabled={busy} maxLength={200} />
          </Field>

          <Field label="Phone" hint="A 10-digit mobile number." error={fieldErrors.phone}>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
              disabled={busy}
              inputMode="numeric"
            />
          </Field>

          <Field label="Product" error={fieldErrors.productId}>
            <ProductField customerId={lead.id} productId={productId} productName={lead.product} disabled={busy} onPick={setProductId} />
          </Field>
        </div>
        {!seats ? (
          <p className="mt-3 text-[12.5px] text-muted">To move the lead to another owner or sales manager, use Reassign on the record.</p>
        ) : null}
        {/* Enter in a box saves, as it did on the page. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
