"use client";

import * as React from "react";
import { Badge, Button, Field, Input, Select, cx } from "@/components/ui/primitives";
import { RowMenu } from "@/components/ui/overlays";
import { CardGrid } from "@/components/ui/card-grid";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import {
  CONTACT_ROLES,
  DESIGNATION_LABELS,
  contactRoleLabel,
  isMobile,
  phoneForReading,
  sortContacts,
  type ContactDesignation,
} from "@/lib/customer-contacts";
import {
  addCustomerContact,
  designateCustomerContact,
  removeCustomerContact,
  updateCustomerContact,
} from "@/lib/actions/customer-contacts";
import type { CustomerContact } from "@/lib/services/customer-contact-service";

/**
 * THE PEOPLE AT A CUSTOMER, AND WHICH NUMBER GETS WHAT.
 *
 * One list, three marks. The panel says, above the list and in words, where a
 * call, a WhatsApp and a payment reminder will go TODAY — including the
 * fallbacks, because "no payment-reminder number" is not "no reminders": they
 * go to the WhatsApp number, and a person setting this up should not have to
 * know that to read it.
 *
 * Rendered on the customer record and inside the edit form, so a correction
 * can be made from whichever screen somebody already has open. Every change
 * is saved as it is made — the list is not part of the form's Save, because a
 * half-edited contact list should never be lost to a Cancel on another tab.
 */
export function CustomerContactsPanel({
  customerId,
  initial,
  canEdit = true,
  onChange,
}: {
  customerId: string;
  initial: CustomerContact[];
  canEdit?: boolean;
  /** Told after every saved change, with the list as the server now holds it. */
  onChange?: (contacts: CustomerContact[]) => void;
}) {
  const { run } = useToast();
  const [contacts, setContacts] = React.useState(() => sortContacts(initial));
  const [editing, setEditing] = React.useState<string | "new" | null>(null);
  const [busy, setBusy] = React.useState(false);

  const apply = (next: CustomerContact[]) => {
    const sorted = sortContacts(next);
    setContacts(sorted);
    onChange?.(sorted);
  };

  const act = async (p: Promise<{ ok: boolean; data?: CustomerContact[]; message?: string; error?: string }>) => {
    setBusy(true);
    try {
      const r = await run(p);
      if (r.ok && r.data) apply(r.data);
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  const primary = contacts.find((c) => c.isPrimary) ?? null;
  const whatsapp = contacts.find((c) => c.forWhatsapp) ?? null;
  const payment = contacts.find((c) => c.forPaymentReminders) ?? null;
  const whatsappEffective = whatsapp ?? primary;
  const paymentEffective = payment ?? whatsappEffective;

  return (
    <div className="flex flex-col gap-3">
      {/* Where each kind of message goes right now, fallbacks named. */}
      <CardGrid min={170} gap="gap-2">
        <RouteTile
          icon="phone"
          label="Calls go to"
          who={primary}
          note={primary ? null : "Nobody — add a number"}
        />
        <RouteTile
          icon="chat"
          label="WhatsApp goes to"
          who={whatsappEffective}
          note={whatsapp ? null : whatsappEffective ? "The primary number, by default" : null}
        />
        <RouteTile
          icon="rupee"
          label="Payment reminders go to"
          who={paymentEffective}
          note={payment ? null : paymentEffective ? (whatsapp ? "The WhatsApp number, by default" : "The primary number, by default") : null}
          tone={payment ? "brand" : undefined}
        />
      </CardGrid>

      <div className="overflow-hidden rounded-[6px] border border-line">
        {contacts.length === 0 && editing !== "new" ? (
          <div className="px-4 py-6 text-center text-[13px] text-muted">
            No numbers recorded for this customer yet.
          </div>
        ) : null}
        {contacts.map((c) =>
          editing === c.id ? (
            <ContactEditor
              key={c.id}
              initial={c}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={async (v) => {
                const okay = await act(updateCustomerContact(c.id, v));
                if (okay) setEditing(null);
              }}
            />
          ) : (
            <ContactRow
              key={c.id}
              contact={c}
              canEdit={canEdit && !busy}
              onlyOne={contacts.length === 1}
              onEdit={() => setEditing(c.id)}
              onDesignate={(d, on) => void act(designateCustomerContact(c.id, d, on))}
              onRemove={() => {
                if (window.confirm(`Remove ${c.name || phoneForReading(c.phone)} from this customer?`)) {
                  void act(removeCustomerContact(c.id));
                }
              }}
            />
          ),
        )}
        {editing === "new" ? (
          <ContactEditor
            busy={busy}
            isFirst={contacts.length === 0}
            onCancel={() => setEditing(null)}
            onSave={async (v) => {
              const okay = await act(addCustomerContact(customerId, v));
              if (okay) setEditing(null);
            }}
          />
        ) : null}
      </div>

      {canEdit && editing !== "new" ? (
        <div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Add contact
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RouteTile({
  icon,
  label,
  who,
  note,
  tone,
}: {
  icon: "phone" | "chat" | "rupee";
  label: string;
  who: CustomerContact | null;
  note: string | null;
  tone?: "brand";
}) {
  return (
    <div
      className={cx(
        "rounded-[4px] border px-3 py-2",
        tone === "brand" ? "border-brand-soft bg-brand-soft/40" : "border-line bg-canvas",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        <Icon name={icon} size={12} />
        {label}
      </div>
      {who ? (
        <div className="mt-0.5 truncate text-sm text-ink" title={`${who.name ?? ""} ${who.phone}`}>
          <span className="font-medium tabular-nums">{phoneForReading(who.phone)}</span>
          {who.name ? <span className="text-muted"> · {who.name}</span> : null}
        </div>
      ) : (
        <div className="mt-0.5 text-sm text-muted">—</div>
      )}
      {note ? <div className="text-[12px] text-muted">{note}</div> : null}
    </div>
  );
}

function ContactRow({
  contact: c,
  canEdit,
  onlyOne,
  onEdit,
  onDesignate,
  onRemove,
}: {
  contact: CustomerContact;
  canEdit: boolean;
  onlyOne: boolean;
  onEdit: () => void;
  onDesignate: (d: ContactDesignation, on: boolean) => void;
  onRemove: () => void;
}) {
  const mobile = isMobile(c.phone);
  const notMobile = "WhatsApp needs a mobile number — this looks like a landline.";
  return (
    <div className="flex items-start gap-3 border-b border-divider px-4 py-3 last:border-b-0">
      <span
        className={cx(
          "mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full text-[13px] font-semibold",
          c.isPrimary ? "bg-brand text-white" : "bg-divider text-body",
        )}
        aria-hidden
      >
        {(c.name?.trim()?.[0] ?? "#").toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-ink">{c.name || "No name"}</span>
          <Badge tone="muted">{contactRoleLabel(c.role)}</Badge>
          {c.isPrimary ? <Badge tone="brand">{DESIGNATION_LABELS.primary.badge}</Badge> : null}
          {c.forWhatsapp ? <Badge tone="success">{DESIGNATION_LABELS.whatsapp.badge}</Badge> : null}
          {c.forPaymentReminders ? <Badge tone="warn">{DESIGNATION_LABELS.payment.badge}</Badge> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-body">
          <a href={`tel:${c.phone}`} className="tabular-nums hover:text-brand">
            {phoneForReading(c.phone)}
          </a>
          {!mobile ? <span className="text-[12px] text-muted">landline</span> : null}
          {c.email ? (
            <a href={`mailto:${c.email}`} className="truncate text-muted hover:text-brand">
              {c.email}
            </a>
          ) : null}
        </div>
        {c.note ? <div className="mt-0.5 text-[12px] text-muted">{c.note}</div> : null}
      </div>
      {canEdit ? (
        <div className="flex flex-none items-center gap-1.5">
          {!c.isPrimary ? (
            <Button variant="ghost" size="sm" onClick={() => onDesignate("primary", true)} title={DESIGNATION_LABELS.primary.meaning}>
              Make primary
            </Button>
          ) : null}
          <RowMenu
            items={[
              {
                label: c.forWhatsapp ? "Stop using for WhatsApp" : DESIGNATION_LABELS.whatsapp.action,
                title: !mobile && !c.forWhatsapp ? notMobile : DESIGNATION_LABELS.whatsapp.meaning,
                disabled: !mobile && !c.forWhatsapp,
                onSelect: () => onDesignate("whatsapp", !c.forWhatsapp),
              },
              {
                label: c.forPaymentReminders ? "Stop using for payment reminders" : DESIGNATION_LABELS.payment.action,
                title: !mobile && !c.forPaymentReminders ? notMobile : DESIGNATION_LABELS.payment.meaning,
                disabled: !mobile && !c.forPaymentReminders,
                onSelect: () => onDesignate("payment", !c.forPaymentReminders),
              },
              { label: "Edit", onSelect: onEdit },
              {
                label: "Remove",
                destructive: true,
                disabled: onlyOne,
                title: onlyOne ? "A customer needs at least one number." : undefined,
                onSelect: onRemove,
              },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

type EditorValues = {
  name: string;
  role: string;
  phone: string;
  email: string;
  note: string;
  designations?: ContactDesignation[];
};

function ContactEditor({
  initial,
  busy,
  isFirst,
  onCancel,
  onSave,
}: {
  initial?: CustomerContact;
  busy: boolean;
  isFirst?: boolean;
  onCancel: () => void;
  onSave: (v: EditorValues) => Promise<void>;
}) {
  const [v, setV] = React.useState<EditorValues>({
    name: initial?.name ?? "",
    role: initial?.role ?? "orders",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    note: initial?.note ?? "",
    designations: [],
  });
  const isNew = !initial;
  const mobile = isMobile(v.phone);
  const toggle = (d: ContactDesignation) =>
    setV((x) => ({
      ...x,
      designations: x.designations?.includes(d)
        ? x.designations.filter((y) => y !== d)
        : [...(x.designations ?? []), d],
    }));

  return (
    <div className="border-b border-divider bg-canvas px-4 py-3 last:border-b-0">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Who answers this number" autoFocus />
        </Field>
        <Field label="Looks after">
          <Select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
            {CONTACT_ROLES.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Phone · required" hint={v.phone && !mobile ? "Read as a landline — it can be rung, not sent WhatsApp." : "10-digit mobile, or a landline with STD code"}>
          <Input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} inputMode="tel" maxLength={16} />
        </Field>
        <Field label="Email">
          <Input value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} type="email" />
        </Field>
        <Field label="Note" className="col-span-2">
          <Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="Best time to call, language, anything worth knowing" />
        </Field>
      </div>
      {isNew ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {isFirst ? (
            <span className="text-[12px] text-muted">The first number on a customer is its primary number.</span>
          ) : (
            <DesignationChip on={v.designations!.includes("primary")} onClick={() => toggle("primary")} label="Primary" />
          )}
          <DesignationChip on={v.designations!.includes("whatsapp")} disabled={!mobile} onClick={() => toggle("whatsapp")} label="Use for WhatsApp" />
          <DesignationChip on={v.designations!.includes("payment")} disabled={!mobile} onClick={() => toggle("payment")} label="Use for payment reminders" />
        </div>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !v.phone.trim()}
          onClick={() =>
            void onSave({
              ...v,
              designations: mobile ? v.designations : v.designations?.filter((d) => d === "primary"),
            })
          }
        >
          {busy ? "Saving…" : isNew ? "Add contact" : "Save contact"}
        </Button>
      </div>
    </div>
  );
}

function DesignationChip({
  on,
  disabled,
  onClick,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? "WhatsApp needs a mobile number." : undefined}
      className={cx(
        "flex h-7 items-center gap-1.5 rounded-[4px] border px-2.5 text-[13px]",
        disabled
          ? "cursor-not-allowed border-line text-line-strong"
          : on
            ? "cursor-pointer border-brand bg-brand-soft font-medium text-[#5223E0]"
            : "cursor-pointer border-line bg-surface text-body hover:bg-canvas",
      )}
    >
      {on ? <Icon name="check" size={12} /> : null}
      {label}
    </button>
  );
}
