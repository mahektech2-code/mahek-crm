"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Checkbox, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { leadConvertibility } from "@/lib/enquiry-labels";
import { offeredSalesTypes } from "@/lib/lead-labels";
import { captureLead } from "@/lib/actions/lead-intake";
import { leadFromEnquiryContextAction, type LeadFromEnquiryContext } from "@/lib/actions/enquiries";

/**
 * CREATE LEAD, on a website enquiry.
 *
 * Manual by design — nothing here runs by itself. The telecaller reads the
 * enquiry, decides it is worth a call, and presses this; the dialog opens with
 * everything the visitor already typed, so what is left to fill in is only what
 * the visitor did not say (usually the town) and the one thing nobody but the
 * telecaller knows, how the lead will be sold.
 *
 * It is not a second way to make a lead. It posts to `captureLead` — the same
 * writer the intake form uses, with the same duplicate guard and the same
 * Suspect rung — carrying `fromEnquiry`, which is what makes the writer point
 * the enquiry at the new lead in its own transaction.
 */
export function CreateLeadCard({
  enquiry,
  deskHref,
}: {
  enquiry: {
    id: string;
    source: string;
    sourceForm: string | null;
    category: string | null;
    customerId: string | null;
    customerName: string | null;
    customerKind: string | null;
    customerOwnerName: string | null;
  };
  /** Where the lead opens, or null where this person does not hold the desk. */
  deskHref: string | null;
}) {
  const may = leadConvertibility(enquiry);
  const [open, setOpen] = React.useState(false);

  /* Linked already: say what it became and whether anybody has it. */
  if (enquiry.customerId) {
    if (enquiry.customerKind !== "lead") return null;
    return (
      <Card className="p-5">
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Lead</div>
        <div className="mt-2 text-sm font-medium text-ink">{enquiry.customerName}</div>
        <div className="text-[13px] text-muted">
          {enquiry.customerOwnerName
            ? `On ${enquiry.customerOwnerName}'s calling desk.`
            : "Created from this enquiry. It has no owner yet, so it is on nobody's calling desk until it is assigned."}
        </div>
        {deskHref ? (
          <Link href={deskHref} className="mt-2 inline-block text-[13px]">
            Open on the Calling desk
          </Link>
        ) : null}
      </Card>
    );
  }

  if (!may.ok) return null;

  return (
    <Card className="p-5">
      <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Lead</div>
      <p className="mt-1.5 text-[13px] text-muted">
        Turn this enquiry into a lead. What the visitor typed is filled in for you.
      </p>
      <Button size="sm" variant="primary" className="mt-2" onClick={() => setOpen(true)}>
        Create lead
      </Button>
      {open ? <CreateLeadDialog enquiryId={enquiry.id} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

type Draft = {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  city: string;
  address: string;
  requirement: string;
  notes: string;
  salesType: "" | "direct" | "third_party";
  ownerId: string;
};

function CreateLeadDialog({ enquiryId, onClose }: { enquiryId: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [ctx, setCtx] = React.useState<LeadFromEnquiryContext | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [duplicate, setDuplicate] = React.useState<string | null>(null);
  const [allowDuplicate, setAllowDuplicate] = React.useState(false);

  /* The dialog is mounted only while open, so this runs once per opening. */
  React.useEffect(() => {
    let live = true;
    void leadFromEnquiryContextAction(enquiryId).then((r) => {
      if (!live) return;
      if (!r.ok) {
        setLoadError(r.error);
        return;
      }
      const p = r.data.enquiry.prefill;
      setCtx(r.data);
      setDraft({
        name: p.name ?? "",
        contactPerson: p.contactPerson ?? "",
        phone: p.phone ?? "",
        email: p.email ?? "",
        city: p.city ?? "",
        address: p.address ?? "",
        requirement: p.requirement ?? "",
        notes: p.notes ?? "",
        salesType: "",
        ownerId: "",
      });
    });
    return () => {
      live = false;
    };
  }, [enquiryId]);

  const set =
    (k: keyof Draft) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setDraft((d) => (d ? { ...d, [k]: e.target.value } : d));

  async function save() {
    if (!draft || !ctx) return;
    setErrors({});
    setFailure(null);
    const salesType = draft.salesType || null;
    if (!salesType) {
      setErrors({ salesType: "Choose how this lead will be sold." });
      return;
    }
    setBusy(true);
    const r = await captureLead({
      salesType,
      name: draft.name,
      companyName: ctx.enquiry.prefill.companyName ?? undefined,
      contactPerson: draft.contactPerson || undefined,
      email: draft.email || undefined,
      phone: draft.phone,
      city: draft.city,
      address: draft.address || undefined,
      requirement: draft.requirement || undefined,
      notes: draft.notes || undefined,
      ownerId: draft.ownerId || null,
      /* Ignored by the writer, which takes the source from the enquiry itself. */
      source: "website",
      allowDuplicate: allowDuplicate || undefined,
      fromEnquiry: { enquiryId },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "duplicate") setDuplicate(r.error);
      if (r.fieldErrors?.length) setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      setFailure(r.error);
      return;
    }
    toast.push(r.message ?? "Lead created.");
    onClose();
    router.refresh();
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={
        <div>
          <div>Create lead</div>
          {ctx ? (
            <div className="text-[13px] font-normal text-muted">From the website · {ctx.enquiry.formLabel} form</div>
          ) : null}
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !draft} onClick={() => void save()}>
            {busy ? "Creating…" : "Create lead"}
          </Button>
        </>
      }
    >
      {loadError ? (
        <p className="text-sm text-danger">{loadError}</p>
      ) : !draft || !ctx ? (
        <p className="text-sm text-muted">Reading the enquiry…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Business name" error={errors.name} className="col-span-2">
            <Input value={draft.name} onChange={set("name")} invalid={!!errors.name} />
          </Field>
          <Field label="Contact person" error={errors.contactPerson}>
            <Input value={draft.contactPerson} onChange={set("contactPerson")} />
          </Field>
          <Field label="Phone" error={errors.phone}>
            <Input value={draft.phone} onChange={set("phone")} invalid={!!errors.phone} inputMode="tel" />
          </Field>
          <Field label="Email" error={errors.email}>
            <Input value={draft.email} onChange={set("email")} invalid={!!errors.email} />
          </Field>
          <Field
            label="Town / city"
            error={errors.city}
            hint={draft.city ? undefined : "The visitor did not say where they are."}
          >
            <Input value={draft.city} onChange={set("city")} invalid={!!errors.city} />
          </Field>
          <Field label="Address" error={errors.address} className="col-span-2">
            <Input value={draft.address} onChange={set("address")} />
          </Field>
          <Field label="What they need" error={errors.requirement} className="col-span-2">
            <Input value={draft.requirement} onChange={set("requirement")} />
          </Field>
          <Field label="What they wrote" error={errors.notes} className="col-span-2">
            <Textarea rows={3} value={draft.notes} onChange={set("notes")} />
          </Field>
          <Field
            label="How will this lead be sold?"
            error={errors.salesType}
            hint="Decides the ladder it climbs. It is never guessed."
          >
            <Select value={draft.salesType} onChange={set("salesType")}>
              <option value="">Choose…</option>
              {offeredSalesTypes().map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          {ctx.canAssign ? (
            <Field label="Give it to" hint="Optional. Without an owner it is on nobody's calling desk.">
              <Select value={draft.ownerId} onChange={set("ownerId")}>
                <option value="">Nobody yet</option>
                {ctx.assignees.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="self-end text-[13px] text-muted">
              The lead is created without an owner. It reaches a calling desk once it is assigned.
            </p>
          )}
          {duplicate ? (
            <div className="col-span-2 rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
              {duplicate}
              <div className="mt-2">
                <Checkbox
                  checked={allowDuplicate}
                  onChange={() => setAllowDuplicate((v) => !v)}
                  label="This is a different shop — raise it anyway"
                />
              </div>
            </div>
          ) : null}
          {failure && !duplicate ? <p className="col-span-2 text-sm text-danger">{failure}</p> : null}
        </div>
      )}
    </Modal>
  );
}
