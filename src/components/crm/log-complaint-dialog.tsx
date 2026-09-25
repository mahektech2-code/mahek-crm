"use client";

import * as React from "react";
import {
  Button,
  Field,
  Input,
  Radio,
  Select,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { ImagePicker } from "@/components/crm/image-picker";
import {
  COMPLAINT_PRIORITIES,
  DEFAULT_COMPLAINT_PRIORITY,
} from "@/lib/complaint-labels";

/* ---------------------------------------------------------------------------
 * LOGGING A COMPLAINT, asked the same way wherever it is asked.
 *
 * There were two of these. The complaints screen had the real one — category,
 * description, photographs, the mobile number the customer rang from, and the
 * Request CN answer accounts pick up. The customer record had a second, much
 * smaller one: category and description, and nothing else. So a telecaller who
 * raised a complaint from the record a customer was on could not attach the
 * photograph of the damaged can they were being told about, and could not
 * record that the customer had asked for a credit note — on the screen you are
 * most likely to be looking at while that customer is on the phone.
 *
 * The two drifting is the ordinary end of a duplicated form: the small one was
 * not a deliberate short version, it was the one nobody went back to when the
 * other grew. One component now, and the difference between the two places it
 * is drawn is exactly one thing.
 *
 * WHAT DIFFERS IS WHO IT IS ABOUT, and that is the `customer` prop.
 *
 *   · From the complaints screen there is no customer yet, so the dialog asks
 *     — a search over company, name and mobile number.
 *   · From a customer record the answer is already on the screen, so it is not
 *     asked. It is still SHOWN, read-only, because a complaint filed against
 *     the wrong account is expensive and a dialog that names nobody is one
 *     somebody has to trust rather than check.
 *
 * `mobileNumber` is the customer's own number in both cases. It travels with
 * the complaint because the person who resolves it rings back, and the account
 * may carry a landline while the complaint came from a mobile somebody wants
 * recorded against it.
 * ------------------------------------------------------------------------- */

export type LogComplaintInput = {
  customerId: string;
  category: string;
  /** Normal, Urgent or Critical, as the severity the column stores. */
  priority: string;
  description: string;
  mobileNumber: string;
  requestCn: boolean;
  images: File[];
};

/** What the picker searches, and what a record hands over already answered. */
export type ComplaintCustomer = { id: string; name: string; phone: string };

type CustomerHit = { id: string; name: string; city: string; phone: string };

export function LogComplaintDialog({
  open,
  onClose,
  categories,
  maxImages,
  customer,
  defaults,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  categories: string[];
  maxImages: number;
  /** Given from a customer record; omitted where the dialog has to ask. */
  customer?: ComplaintCustomer;
  /**
   * What the call assistant heard, to open the form holding it. A category
   * the configured list does not carry is ignored rather than added — the
   * list is what the save validates against.
   */
  defaults?: { category?: string | null; description?: string | null; requestCn?: boolean };
  onSubmit: (input: LogComplaintInput) => Promise<void>;
}) {
  if (!open) return null;
  return (
    <LogComplaintDialogBody
      /* Remounted per customer so a second complaint never opens holding the
       * first one's description — the same reason every dialog in this app is
       * keyed rather than reset in an effect. */
      key={customer?.id ?? "search"}
      categories={categories}
      maxImages={maxImages}
      customer={customer}
      defaults={defaults}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function LogComplaintDialogBody({
  categories,
  maxImages,
  customer: fixedCustomer,
  defaults,
  onClose,
  onSubmit,
}: {
  categories: string[];
  maxImages: number;
  customer?: ComplaintCustomer;
  defaults?: { category?: string | null; description?: string | null; requestCn?: boolean };
  onClose: () => void;
  onSubmit: (input: LogComplaintInput) => Promise<void>;
}) {
  const [customerQuery, setCustomerQuery] = React.useState("");
  const [customerHits, setCustomerHits] = React.useState<CustomerHit[]>([]);
  const [picked, setPicked] = React.useState<ComplaintCustomer | null>(null);
  const [category, setCategory] = React.useState<string>(
    defaults?.category && categories.includes(defaults.category)
      ? defaults.category
      : (categories[0] ?? "Other"),
  );
  const [priority, setPriority] = React.useState<string>(
    DEFAULT_COMPLAINT_PRIORITY,
  );
  const [description, setDescription] = React.useState(defaults?.description ?? "");
  const [images, setImages] = React.useState<File[]>([]);
  const [requestCn, setRequestCn] = React.useState(Boolean(defaults?.requestCn));
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{
    customer?: string;
    description?: string;
  }>({});

  // The one given to us wins, and cannot be cleared: this dialog was opened
  // from that customer's own record.
  const customer = fixedCustomer ?? picked;
  const searchActive = !fixedCustomer && !picked && customerQuery.trim().length >= 2;

  // Stale hits from a previous query must never show once search is inactive.
  const visibleHits = searchActive ? customerHits : [];

  React.useEffect(() => {
    if (!searchActive) return;
    const term = customerQuery.trim();
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          setCustomerHits(data.customers ?? []);
        }
      } catch {
        /* aborted */
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [customerQuery, searchActive]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Log complaint"
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (!customer) {
                setErrors({ customer: "Pick the customer this complaint is about." });
                return;
              }
              if (!description.trim()) {
                setErrors({
                  description: "Describe the complaint in the customer's words.",
                });
                return;
              }
              setErrors({});
              setBusy(true);
              try {
                await onSubmit({
                  customerId: customer.id,
                  category,
                  priority,
                  description,
                  mobileNumber: customer.phone,
                  requestCn,
                  images,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Company / Customer Name" error={errors.customer ?? null}>
          {customer ? (
            <div className="flex h-8.5 items-center justify-between rounded-[4px] border border-line bg-canvas px-2.5 text-sm text-ink">
              <span className="min-w-0 truncate">{customer.name}</span>
              {/* No way back to the search where the record chose for us:
                * "Change" there would offer to file this complaint against a
                * different account than the page it was raised from. */}
              {fixedCustomer ? null : (
                <button
                  type="button"
                  className="flex-none cursor-pointer text-[13px] text-muted hover:text-ink"
                  onClick={() => {
                    setPicked(null);
                    setCustomerQuery("");
                  }}
                >
                  Change
                </button>
              )}
            </div>
          ) : (
            <div className="relative">
              <Input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Search by company, customer name or mobile number…"
              />
              {visibleHits.length ? (
                <div className="absolute top-9 right-0 left-0 z-10 max-h-48 overflow-auto rounded-[6px] border border-line bg-surface py-1 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
                  {visibleHits.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
                      onClick={() => {
                        setPicked({ id: c.id, name: c.name, phone: c.phone });
                        setCustomerHits([]);
                        setCustomerQuery("");
                      }}
                    >
                      <span className="text-sm font-medium text-ink">{c.name}</span>
                      <span className="text-[13px] text-muted">{c.city}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </Field>

        <Field label="Mobile number">
          <Input
            value={customer?.phone ?? ""}
            readOnly
            disabled
            placeholder="Pick a customer first"
          />
        </Field>

        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>

        {/* Under Category, because the two are one judgement: what kind of
          * problem this is, and how badly it needs answering. It sets the
          * resolution deadline through `complaints.slaHours`, which is why the
          * hint names the consequence rather than describing the words. */}
        <Field
          label="Priority"
          hint={
            priority === "medium"
              ? undefined
              : "Shortens the resolution deadline this complaint is held to."
          }
        >
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {COMPLAINT_PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Complaint description" error={errors.description ?? null}>
          <VoiceTextarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setErrors({});
            }}
            onDictate={(v) => {
              setDescription(v);
              setErrors({});
            }}
            className="h-24"
            placeholder="Describe the complaint in detail."
          />
        </Field>

        <ImagePicker files={images} onChange={setImages} max={maxImages} />

        <Field
          label="Request CN"
          hint={
            requestCn
              ? "Accounts take it from here - they pick up the bill and the amount."
              : undefined
          }
        >
          <div className="flex items-center gap-4">
            <Radio
              name="requestCn"
              label="No"
              checked={!requestCn}
              onChange={() => setRequestCn(false)}
            />
            <Radio
              name="requestCn"
              label="Yes"
              checked={requestCn}
              onChange={() => setRequestCn(true)}
            />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
