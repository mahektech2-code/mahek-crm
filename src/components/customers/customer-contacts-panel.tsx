"use client";

import * as React from "react";
import { Badge, Button, Field, Input, Select, cx } from "@/components/ui/primitives";
import { Modal, RowMenu } from "@/components/ui/overlays";
import { CardGrid } from "@/components/ui/card-grid";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import {
  BIRTH_MONTH_NAMES,
  CONTACT_ROLES,
  DESIGNATION_LABELS,
  birthdayLabel,
  birthdayProblem,
  birthdayWhen,
  contactRoleLabel,
  daysInBirthMonth,
  daysUntilBirthday,
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
  today,
  birthdayHeadsUpDays = 7,
}: {
  customerId: string;
  initial: CustomerContact[];
  canEdit?: boolean;
  /**
   * The business date (YYYY-MM-DD), read on the server — a client component
   * may not read the clock in render. Without it a birthday shows its date
   * and no countdown.
   */
  today?: string;
  /** How far ahead a birthday is called out — `customers.birthdayHeadsUpDays`. */
  birthdayHeadsUpDays?: number;
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

  const editingContact =
    editing && editing !== "new" ? (contacts.find((c) => c.id === editing) ?? null) : null;
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

      {/*
        ONE CARD PER PERSON, with space between them, and the form in a
        dialog. Editing used to open in place inside the list, so a contact
        being read and a contact being changed looked alike and sat flush
        against each other — nobody could tell which one the fields belonged
        to, or whether they were adding a new one.
      */}
      {contacts.length ? (
        <div className="flex flex-col gap-2">
          {contacts.map((c) => (
            <ContactRow
              key={c.id}
              contact={c}
              canEdit={canEdit && !busy}
              onlyOne={contacts.length === 1}
              today={today}
              birthdayHeadsUpDays={birthdayHeadsUpDays}
              onEdit={() => setEditing(c.id)}
              onDesignate={(d, on) => void act(designateCustomerContact(c.id, d, on))}
              onRemove={() => {
                if (window.confirm(`Remove ${c.name || phoneForReading(c.phone)} from this customer?`)) {
                  void act(removeCustomerContact(c.id));
                }
              }}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-[6px] border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
          No numbers recorded for this customer yet.
        </div>
      )}

      {canEdit ? (
        <div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Add contact
          </Button>
        </div>
      ) : null}

      {editingContact || editing === "new" ? (
        <ContactDialog
          key={editing ?? "new"}
          initial={editingContact ?? undefined}
          busy={busy}
          isFirst={contacts.length === 0}
          onCancel={() => setEditing(null)}
          onSave={async (values) => {
            // The selects hold text; the action takes the numbers, or null for none.
            const v = {
              ...values,
              birthDay: values.birthDay ? Number(values.birthDay) : null,
              birthMonth: values.birthMonth ? Number(values.birthMonth) : null,
            };
            if (!editingContact) {
              const okay = await act(addCustomerContact(customerId, v));
              if (okay) setEditing(null);
              return;
            }
            // The details, then whichever marks changed — each mark is its
            // own action because each moves a number other screens read.
            let okay = await act(updateCustomerContact(editingContact.id, v));
            const want = new Set(v.designations ?? []);
            const had = designationsOf(editingContact);
            for (const d of ["primary", "whatsapp", "payment"] as const) {
              if (!okay) break;
              if (want.has(d) !== had.has(d)) {
                okay = await act(designateCustomerContact(editingContact.id, d, want.has(d)));
              }
            }
            if (okay) setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function designationsOf(c: CustomerContact): Set<ContactDesignation> {
  const out = new Set<ContactDesignation>();
  if (c.isPrimary) out.add("primary");
  if (c.forWhatsapp) out.add("whatsapp");
  if (c.forPaymentReminders) out.add("payment");
  return out;
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
  today,
  birthdayHeadsUpDays,
  onEdit,
  onDesignate,
  onRemove,
}: {
  contact: CustomerContact;
  canEdit: boolean;
  onlyOne: boolean;
  today?: string;
  birthdayHeadsUpDays: number;
  onEdit: () => void;
  onDesignate: (d: ContactDesignation, on: boolean) => void;
  onRemove: () => void;
}) {
  const mobile = isMobile(c.phone);
  const notMobile = "WhatsApp needs a mobile number — this looks like a landline.";
  const birthday = birthdayLabel(c.birthDay, c.birthMonth);
  const untilBirthday = today ? daysUntilBirthday(c.birthDay, c.birthMonth, today) : null;
  const birthdaySoon = untilBirthday !== null && untilBirthday <= birthdayHeadsUpDays;
  return (
    <div
      className={cx(
        "flex items-start gap-3 rounded-[6px] border bg-surface px-4 py-3",
        c.isPrimary ? "border-brand-softer" : "border-line",
      )}
    >
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
          {birthdaySoon ? <Badge tone="brand">{birthdayWhen(untilBirthday!)}</Badge> : null}
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
          {birthday ? (
            <span className="inline-flex items-center gap-1 text-muted" title="Birthday">
              <Icon name="gift" size={12} />
              {birthday}
            </span>
          ) : null}
        </div>
        {c.note ? <div className="mt-0.5 text-[12px] text-muted">{c.note}</div> : null}
      </div>
      {canEdit ? (
        <div className="flex flex-none items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <RowMenu
            items={[
              ...(c.isPrimary
                ? []
                : [
                    {
                      label: DESIGNATION_LABELS.primary.action,
                      title: DESIGNATION_LABELS.primary.meaning,
                      onSelect: () => onDesignate("primary", true),
                    },
                  ]),
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
  /** "" where none is picked — a select's own empty value. */
  birthDay: string;
  birthMonth: string;
  designations?: ContactDesignation[];
};

function ContactDialog({
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
    birthDay: initial?.birthDay ? String(initial.birthDay) : "",
    birthMonth: initial?.birthMonth ? String(initial.birthMonth) : "",
    designations: initial ? [...designationsOf(initial)] : [],
  });
  const birthdayWrong = birthdayProblem(
    v.birthDay ? Number(v.birthDay) : null,
    v.birthMonth ? Number(v.birthMonth) : null,
  );
  const dayCount = v.birthMonth ? daysInBirthMonth(Number(v.birthMonth)) : 31;
  const isNew = !initial;
  const mobile = isMobile(v.phone);
  const toggle = (d: ContactDesignation) =>
    setV((x) => ({
      ...x,
      designations: x.designations?.includes(d)
        ? x.designations.filter((y) => y !== d)
        : [...(x.designations ?? []), d],
    }));
  // The primary cannot be un-made from here: a customer always has one, and
  // the way to move it is to make somebody else primary.
  const lockedPrimary = Boolean(initial?.isPrimary);
  const submit = () =>
    void onSave({
      ...v,
      designations: mobile ? v.designations : v.designations?.filter((d) => d === "primary"),
    });

  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      title={isNew ? "Add a contact" : `Edit contact — ${initial?.name || phoneForReading(initial?.phone ?? "")}`}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !v.phone.trim() || Boolean(birthdayWrong)} onClick={submit}>
            {busy ? "Saving…" : isNew ? "Add contact" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
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
        <Field
          label="Birthday"
          className="col-span-2"
          hint={birthdayWrong ?? "Day and month only — no year is asked."}
        >
          <div className="grid grid-cols-[120px_1fr_auto] items-center gap-2">
            <Select
              aria-label="Birthday day"
              value={v.birthDay}
              onChange={(e) => setV({ ...v, birthDay: e.target.value })}
            >
              <option value="">Day</option>
              {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
                <option key={d} value={String(d)}>
                  {d}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Birthday month"
              value={v.birthMonth}
              onChange={(e) => {
                const month = e.target.value;
                // A day the new month cannot hold is cleared, not carried into an error.
                const keepDay = !month || !v.birthDay || Number(v.birthDay) <= daysInBirthMonth(Number(month));
                setV({ ...v, birthMonth: month, birthDay: keepDay ? v.birthDay : "" });
              }}
            >
              <option value="">Month</option>
              {BIRTH_MONTH_NAMES.map((m, i) => (
                <option key={m} value={String(i + 1)}>
                  {m}
                </option>
              ))}
            </Select>
            {v.birthDay || v.birthMonth ? (
              <Button variant="ghost" size="sm" onClick={() => setV({ ...v, birthDay: "", birthMonth: "" })}>
                Clear
              </Button>
            ) : (
              <span />
            )}
          </div>
        </Field>
        <Field label="Note" className="col-span-2">
          <Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="Best time to call, language, anything worth knowing" />
        </Field>
      </div>

      <div className="mt-4 border-t border-divider pt-3.5">
        <div className="mb-2 text-[12px] font-medium text-muted">Use this number for</div>
        <div className="flex flex-wrap gap-2">
          {isNew && isFirst ? (
            <span className="text-[12px] text-muted">The first number on a customer is its primary number.</span>
          ) : (
            <DesignationChip
              on={v.designations!.includes("primary")}
              disabled={lockedPrimary}
              disabledTitle="Make another contact primary to move this."
              onClick={() => toggle("primary")}
              label="Calls (primary)"
            />
          )}
          <DesignationChip on={v.designations!.includes("whatsapp")} disabled={!mobile} onClick={() => toggle("whatsapp")} label="WhatsApp" />
          <DesignationChip on={v.designations!.includes("payment")} disabled={!mobile} onClick={() => toggle("payment")} label="Payment reminders" />
        </div>
      </div>
    </Modal>
  );
}

function DesignationChip({
  on,
  disabled,
  disabledTitle = "WhatsApp needs a mobile number.",
  onClick,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? disabledTitle : undefined}
      className={cx(
        "flex h-7 items-center gap-1.5 rounded-[4px] border px-2.5 text-[13px]",
        // A mark that is ON and cannot be turned off here (the primary) still
        // reads as on; only an unavailable OFF chip greys out.
        disabled && on
          ? "cursor-not-allowed border-brand bg-brand-soft font-medium text-[#5223E0]"
          : disabled
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
