"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { Badge, Button, Field, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { saveInteractionAction } from "@/lib/actions/crm";
import { money, phoneDisplay, today } from "@/lib/format";

export type CallTarget = {
  customerId: string;
  /** Where this was started from — kept on the interaction record. */
  sourceModule?:
    | "call_queue"
    | "payment_follow_up"
    | "inactive_watch"
    | "customer_record"
    | "ad_hoc";
  queuePosition?: number;
  name: string;
  contactPerson: string;
  phone: string;
  city: string;
  ownerName: string | null;
  reason?: string;
  outstanding: number;
  lastOrderDate: string | null;
  lastOrderValue: number;
  creditTermDays: number;
  targetGap: number;
  openComplaint?: string | null;
  history?: HistoryEntry[];
};

export type HistoryEntry = {
  kind: string;
  at: string;
  actor: string;
  content: string;
};

export type InteractionType = "outbound_call" | "inbound_call" | "order_received";

export type QuickNoteOption = {
  id: string;
  interactionType: InteractionType;
  outcome: string | null;
  label: string;
};

export type ProductOption = { id: string; name: string; packSize: string | null };

const TYPES: Array<{ key: InteractionType; label: string; sub: string; icon: string }> = [
  { key: "outbound_call", label: "We Called Them", sub: "An outbound call you made", icon: "phone" },
  { key: "inbound_call", label: "They Called Us", sub: "The customer rang in", icon: "phone" },
  {
    key: "order_received",
    label: "Order Received",
    sub: "Arrived by WhatsApp or ERP — no call",
    icon: "doc",
  },
];

/** Exactly the sets from the brief. Nothing added. */
const OUTCOMES: Record<Exclude<InteractionType, "order_received">, string[]> = {
  outbound_call: [
    "order_taken",
    "no_order",
    "no_answer",
    "payment_promised",
    "follow_up",
    "not_interested",
  ],
  inbound_call: [
    "order_taken",
    "payment_promised",
    "follow_up",
    "complaint",
    "transport_follow_up",
    "casual_talk",
  ],
};

const OUTCOME_LABEL: Record<string, string> = {
  order_taken: "Order Taken",
  no_order: "No Order",
  no_answer: "No Answer",
  payment_promised: "Payment Promised",
  follow_up: "Follow-up",
  not_interested: "Not Interested",
  complaint: "Complaint",
  transport_follow_up: "Transport Follow-up",
  casual_talk: "Casual Talk",
};

type CallPanelProps = {
  target: CallTarget | null;
  quickNotes: QuickNoteOption[];
  products: ProductOption[];
  complaintCategories: Array<{ value: string; label: string }>;
  /** Products this customer has bought before — the "Usually buys" row. */
  frequentProductIds?: string[];
  onClose: () => void;
  onSaved?: (advance: boolean) => void;
  hasNext?: boolean;
};

/**
 * Keyed on the customer, so moving to the next call always opens a blank form.
 * Carrying one customer's outcome into the next is the worst bug this screen
 * could have.
 */
export function CallPanel(props: CallPanelProps) {
  if (!props.target) return null;
  return <CallPanelForm key={props.target.customerId} {...props} />;
}

function CallPanelForm({
  target,
  quickNotes,
  products,
  complaintCategories,
  frequentProductIds = [],
  onClose,
  onSaved,
  hasNext,
}: CallPanelProps) {
  const router = useRouter();
  const { run, push } = useToast();

  const [type, setType] = React.useState<InteractionType | null>(null);
  const [outcome, setOutcome] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [quantities, setQuantities] = React.useState<Record<string, string>>({});
  const [followUpDate, setFollowUpDate] = React.useState("");
  const [payDate, setPayDate] = React.useState("");
  const [category, setCategory] = React.useState(complaintCategories[0]?.value ?? "other");
  const [orderDate, setOrderDate] = React.useState(today());
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saved, setSaved] = React.useState<string | null>(null);

  // One key per opening, so a double-click logs one interaction, not two.
  const idempotencyKey = React.useRef(crypto.randomUUID());

  const isOrderReceived = type === "order_received";
  const chosen = isOrderReceived || Boolean(outcome);

  const needsProducts = isOrderReceived || outcome === "order_taken";
  const needsFollowUp = outcome === "follow_up";
  const needsPayDate = type === "inbound_call" && outcome === "payment_promised";
  const showPayDate = outcome === "payment_promised";
  const needsCategory = outcome === "complaint";

  const chips = React.useMemo(
    () =>
      quickNotes.filter(
        (n) => n.interactionType === type && (n.outcome ?? null) === (outcome ?? null),
      ),
    [quickNotes, type, outcome],
  );

  const frequent = products.filter((p) => frequentProductIds.includes(p.id));
  const productLabel = (p: ProductOption) =>
    p.packSize ? `${p.name} — ${p.packSize}` : p.name;

  function applyChip(n: QuickNoteOption) {
    // Chips accumulate. Clicking three appends three, and the text stays
    // editable afterwards — nothing is locked.
    setPicked((p) => (p.includes(n.id) ? p : [...p, n.id]));
    setNotes((t) => (t.trim() ? `${t.trim()} ${n.label}` : n.label));
  }

  async function save(advance: boolean) {
    if (!target) return;
    setBusy(true);
    try {
      const productQuantities: Record<string, number> = {};
      for (const [pid, raw] of Object.entries(quantities)) {
        const q = Number(raw);
        if (Number.isFinite(q) && q > 0) productQuantities[pid] = Math.round(q);
      }

      const result = await run(
        saveInteractionAction({
          customerId: target.customerId,
          interactionType: type!,
          outcome: isOrderReceived ? null : outcome,
          notes,
          quickNoteIds: picked,
          productQuantities,
          followUpDate: needsFollowUp ? followUpDate : undefined,
          paymentPromiseDate: showPayDate ? payDate || undefined : undefined,
          complaintCategory: needsCategory ? category : undefined,
          orderDate: isOrderReceived ? orderDate : undefined,
          sourceModule: target.sourceModule ?? "ad_hoc",
          queuePosition: target.queuePosition,
          idempotencyKey: idempotencyKey.current,
        }),
      );

      if (result.ok) {
        setErrors({});
        setSaved(
          isOrderReceived
            ? "Order logged"
            : `${OUTCOME_LABEL[outcome!] ?? "Interaction"} logged`,
        );
        router.refresh();
        if (advance) onSaved?.(true);
      } else if (result.fieldErrors?.length) {
        // The server names the field, so the message lands next to it.
        setErrors(Object.fromEntries(result.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setType(null);
    setOutcome(null);
    setNotes("");
    setPicked([]);
    setQuantities({});
    setFollowUpDate("");
    setPayDate("");
    setOrderDate(today());
    setErrors({});
    setSaved(null);
    idempotencyKey.current = crypto.randomUUID();
  }

  if (!target) return null;

  return (
    <Drawer open onClose={onClose} label={`Log interaction · ${target.name}`}>
      <DrawerHeader onClose={onClose}>
        <div className="text-lg leading-6 font-semibold text-ink">{target.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <span>{target.contactPerson}</span>
          <span>·</span>
          <a href={`tel:${target.phone}`} className="font-medium text-ink no-underline">
            {phoneDisplay(target.phone)}
          </a>
          <button
            title="Copy number"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(target.phone);
                push("Number copied");
              } catch {
                push("The browser blocked the clipboard.", "error");
              }
            }}
            className="inline-flex h-5.5 w-5.5 cursor-pointer items-center justify-center rounded-[4px] border border-line text-muted hover:bg-canvas hover:text-body"
          >
            <Icon name="copy" size={12} strokeWidth={1.8} />
          </button>
        </div>
        {target.reason ? (
          <div className="mt-1.5">
            <Badge tone="brand">{target.reason}</Badge>
          </div>
        ) : null}
        {target.openComplaint ? (
          <div className="mt-1.5 rounded-[4px] border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[13px] text-danger">
            Open complaint — mention it first: {target.openComplaint}
          </div>
        ) : null}
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto p-5">
        {saved ? (
          <div className="rounded-[6px] border border-line bg-surface p-5 text-center">
            <div className="text-lg font-semibold text-ink">Log saved</div>
            <div className="mt-1 text-sm text-muted">{saved}</div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {hasNext ? (
                <Button variant="primary" onClick={() => onSaved?.(true)}>
                  Next customer
                </Button>
              ) : null}
              <Button variant="secondary" onClick={reset}>
                Log another interaction
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : !type ? (
          <>
            <div className="text-[15px] font-semibold text-ink">
              How did this interaction happen?
            </div>
            <p className="mt-1 mb-3.5 text-[13px] text-muted">
              Pick one to start. Everything after this depends on it.
            </p>
            <div className="flex flex-col gap-2">
              {TYPES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setType(t.key)}
                  className="flex cursor-pointer items-center gap-3 rounded-[4px] border border-line bg-surface px-3 py-2.5 text-left hover:border-brand"
                >
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-[#5223E0]">
                    <Icon name={t.icon} size={18} />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-ink">{t.label}</span>
                    <span className="block text-[13px] text-muted">{t.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : !chosen ? (
          <>
            <button
              onClick={() => setType(null)}
              className="mb-3 cursor-pointer text-[13px] text-brand"
            >
              ← {TYPES.find((t) => t.key === type)?.label}
            </button>
            <div className="text-[15px] font-semibold text-ink">What was the outcome?</div>
            <div className="mt-3 flex flex-col gap-2">
              {OUTCOMES[type as Exclude<InteractionType, "order_received">].map((o) => (
                <button
                  key={o}
                  onClick={() => setOutcome(o)}
                  className="cursor-pointer rounded-[4px] border border-line bg-surface px-3 py-2.5 text-left text-sm font-medium text-ink hover:border-brand"
                >
                  {OUTCOME_LABEL[o]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <button
              onClick={() => (isOrderReceived ? setType(null) : setOutcome(null))}
              className="mb-3 cursor-pointer text-[13px] text-brand"
            >
              ← {TYPES.find((t) => t.key === type)?.label}
              {outcome ? ` · ${OUTCOME_LABEL[outcome]}` : ""}
            </button>

            {isOrderReceived ? (
              <Field
                label="Order date"
                hint="Choose the date the order came in."
                error={errors.orderDate ?? null}
              >
                <Input
                  type="date"
                  value={orderDate}
                  max={today()}
                  onChange={(e) => setOrderDate(e.target.value)}
                />
              </Field>
            ) : null}

            {needsFollowUp ? (
              <Field
                label="Follow-up date"
                hint="Pick the follow-up date — it becomes a reminder you will see on the day."
                error={errors.followUpDate ?? null}
              >
                <Input
                  type="date"
                  value={followUpDate}
                  min={today()}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                />
              </Field>
            ) : null}

            {showPayDate ? (
              <Field
                label={needsPayDate ? "Payment date" : "Payment date (optional)"}
                hint="Enter the date they committed to."
                error={errors.paymentPromiseDate ?? null}
              >
                <Input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </Field>
            ) : null}

            {needsCategory ? (
              <Field label="Complaint category" error={errors.complaintCategory ?? null}>
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {complaintCategories.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            {needsProducts ? (
              <div className="mb-3.5">
                <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Products and quantity
                </span>
                {frequent.length ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] text-muted">Usually buys</span>
                    {frequent.map((p) => (
                      <button
                        key={p.id}
                        onClick={() =>
                          setQuantities((q) => ({ ...q, [p.id]: q[p.id] || "1" }))
                        }
                        className="cursor-pointer rounded-full border border-line bg-surface px-2.5 py-1 text-[13px] text-body hover:border-brand"
                      >
                        {productLabel(p)}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 max-h-56 overflow-y-auto rounded-[4px] border border-line">
                  {products.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 border-b border-divider px-3 py-2 last:border-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-body">
                        {productLabel(p)}
                      </span>
                      <input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={quantities[p.id] ?? ""}
                        onChange={(e) =>
                          setQuantities((q) => ({ ...q, [p.id]: e.target.value }))
                        }
                        placeholder="0"
                        className="h-8 w-[70px] rounded-[4px] border border-line px-2 text-right text-sm"
                      />
                    </div>
                  ))}
                </div>
                {errors.productQuantities ? (
                  <p className="mt-1 text-[13px] text-danger">{errors.productQuantities}</p>
                ) : null}
              </div>
            ) : null}

            {chips.length ? (
              <div className="mb-3.5">
                <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Quick notes
                </span>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {chips.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => applyChip(c)}
                      className={cx(
                        "cursor-pointer rounded-full border px-2.5 py-1 text-[13px]",
                        picked.includes(c.id)
                          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                          : "border-line bg-surface text-body hover:border-brand",
                      )}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <Field
              label="Notes"
              hint="Quick notes add to this — you can edit it freely afterwards."
              error={errors.notes ?? null}
            >
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="h-20"
                placeholder="What was said, in your own words"
              />
            </Field>
          </>
        )}
      </div>

      {chosen && !saved ? (
        <div className="flex gap-2.5 border-t border-line px-5 py-3">
          <Button variant="primary" disabled={busy} onClick={() => save(false)}>
            Save log
          </Button>
          {hasNext ? (
            <Button variant="secondary" disabled={busy} onClick={() => save(true)}>
              Save and next
            </Button>
          ) : null}
          <span className="flex-1" />
          {target.outstanding > 0 ? (
            <span className="self-center text-[13px] text-muted">
              {money(target.outstanding)} outstanding
            </span>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
