"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { useEscape } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { saveInteractionAction } from "@/lib/actions/crm";
import { money, phoneDisplay, shortDate, today } from "@/lib/format";

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

/** A call script from the help centre, matched to the chosen outcome. */
export type ScriptOption = {
  id: string;
  title: string;
  body: string;
  /** Which outcome it belongs to; null means it applies generally. */
  outcome: string | null;
};

/** §7 — what the information strip shows. Derived server-side. */
export type CustomerInfo = {
  purchase: {
    lastOrderDate: string | null;
    lastOrderDaysAgo: number | null;
    cycleDays: number;
    cycleIsDefault: boolean;
    nextOrderDate: string | null;
    lastCallDate: string | null;
    lastCallDaysAgo: number | null;
  };
  monthly: {
    target: number;
    achieved: number;
    achievementPercent: number;
    gap: number;
    workingDaysRemaining: number;
    requiredPerDay: number;
    shortfallPerDay: number;
  };
  outstanding: number;
  creditDays: number;
  creditDaysIsDefault: boolean;
  recentCalls: Array<{
    id: string;
    at: string;
    outcome: string | null;
    notes: string | null;
  }>;
  productHistory: Array<{
    productName: string;
    lastPurchaseDate: string | null;
    totalOrderCount: number;
  }>;
  productHistorySource: "external" | "crm";
};

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
  scripts?: ScriptOption[];
  /** Products this customer has bought before — the "Usually buys" row. */
  frequentProductIds?: string[];
  onClose: () => void;
  onSaved?: (advance: boolean) => void;
  hasNext?: boolean;
  hasPrevious?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  /** "3 of 12" — where this customer sits in the queue. */
  position?: string;
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
  scripts = [],
  frequentProductIds = [],
  onClose,
  onSaved,
  hasNext,
  hasPrevious,
  onPrevious,
  onNext,
  position,
}: CallPanelProps) {
  useEscape(onClose);
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
  // Opens on Information: read who you are about to speak to before speaking.
  // "Log this call" in the footer is the way through to the form.
  const [tab, setTab] = React.useState<"log" | "information" | "script">("information");
  const [productQuery, setProductQuery] = React.useState("");

  // One key per opening, so a double-click logs one interaction, not two.
  const idempotencyKey = React.useRef(crypto.randomUUID());

  // The information strip loads with the panel rather than being prefetched
  // for every row behind it — most rows are never opened.
  const [info, setInfo] = React.useState<CustomerInfo | null>(null);
  React.useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    fetch(`/api/customer-info?customerId=${target.customerId}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : { info: null }))
      .then((d) => setInfo(d.info))
      .catch(() => setInfo(null));
    return () => controller.abort();
  }, [target]);

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

  // The script follows the outcome once one is chosen; before that, whatever
  // general guidance exists.
  const script =
    scripts.find((x) => x.outcome && x.outcome === outcome) ??
    scripts.find((x) => !x.outcome) ??
    null;

  const frequent = products.filter((p) => frequentProductIds.includes(p.id));
  const productLabel = (p: ProductOption) =>
    p.packSize ? `${p.name} — ${p.packSize}` : p.name;

  // A real catalogue is far too long to scroll mid-call, so the list is
  // searchable by name, pack size or code.
  const matches = React.useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      `${p.name} ${p.packSize ?? ""}`.toLowerCase().includes(q),
    );
  }, [products, productQuery]);

  // What has actually been put on the order, read back so nothing is added by
  // accident and left unnoticed.
  const onThisOrder = products
    .map((p) => ({ product: p, qty: Number(quantities[p.id]) }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0);

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
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Log interaction · ${target.name}`}
      className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(26,30,40,0.45)] p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[760px] max-h-[calc(100vh-48px)] w-[1160px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[6px] bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        {/* ------------------------------------------------------- header */}
        <div className="flex items-start gap-4 border-b border-divider px-6 py-4">
          <div className="min-w-0 flex-1">
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
              <span>·</span>
              <span>{target.city}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close"
            className="inline-flex h-5.5 w-5.5 flex-none cursor-pointer items-center justify-center rounded-[4px] border border-line text-muted hover:bg-canvas hover:text-body"
          >
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>

        {/* The four figures a telecaller needs before they speak. */}
        <div className="grid grid-cols-[repeat(4,minmax(0,1fr))] gap-4 border-b border-divider bg-canvas px-6 py-3">
          <Stat
            label="Outstanding"
            tone={target.outstanding > 0 ? "danger" : undefined}
          >
            {money(target.outstanding)}
          </Stat>
          <Stat label="Target gap">{money(target.targetGap)}</Stat>
          <Stat label="Reminder">{target.reason ?? "—"}</Stat>
          <Stat
            label="Open complaint"
            tone={target.openComplaint ? "danger" : undefined}
          >
            {target.openComplaint ? "Yes — mention it first" : "None"}
          </Stat>
        </div>

        {/* --------------------------------------- information | the form */}
        {/* ---------------------------------------------------- the tabs */}
        <div className="flex items-center gap-1 border-b border-divider px-6">
          {(
            [
              { key: "information" as const, label: "Information" },
              { key: "log" as const, label: "Call Log" },
              { key: "script" as const, label: "Script" },
            ]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cx(
                "cursor-pointer border-b-2 px-3 py-2.5 text-sm",
                tab === t.key
                  ? "border-brand font-medium text-ink"
                  : "border-transparent text-muted hover:text-body",
              )}
            >
              {t.label}
              {/* The dot marks the tab still holding unfinished work. */}
              {t.key === "log" && chosen && !saved ? (
                <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle" />
              ) : null}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1">
          <div
            className={cx(
              "h-full min-h-0 overflow-y-auto p-5",
              tab === "information" ? "block" : "hidden",
            )}
          >
            {info ? (
<>
              <InfoRow label="Purchase summary">
                <Figure label="Last order">
                  {info.purchase.lastOrderDate
                    ? `${shortDate(info.purchase.lastOrderDate)} · ${info.purchase.lastOrderDaysAgo}d ago`
                    : "Never"}
                </Figure>
                <Figure label="Purchase cycle">
                  {info.purchase.cycleDays} days
                  {info.purchase.cycleIsDefault ? " (default)" : ""}
                </Figure>
                <Figure label="Next order">
                  {info.purchase.nextOrderDate
                    ? shortDate(info.purchase.nextOrderDate)
                    : "—"}
                </Figure>
                <Figure label="Last call">
                  {info.purchase.lastCallDate
                    ? `${shortDate(info.purchase.lastCallDate)} · ${info.purchase.lastCallDaysAgo}d ago`
                    : "Never"}
                </Figure>
              </InfoRow>

              <InfoRow label="Monthly performance">
                <Figure label="Monthly target">{money(info.monthly.target)}</Figure>
                <Figure label="Achieved">
                  {money(info.monthly.achieved)} · {info.monthly.achievementPercent}%
                </Figure>
                <Figure label="Target gap this month">
                  {money(info.monthly.gap)}
                  <span className="ml-1 text-[11px] font-normal text-muted">
                    {info.monthly.workingDaysRemaining} working days left
                  </span>
                </Figure>
                <Figure label="Run rate">
                  Need {money(info.monthly.requiredPerDay)}/day
                  {info.monthly.shortfallPerDay > 0 ? (
                    <span className="ml-1 text-[11px] font-normal text-danger">
                      Short by {money(info.monthly.shortfallPerDay)}/day
                    </span>
                  ) : null}
                </Figure>
              </InfoRow>

              <InfoRow label="Account">
                <Figure label="Outstanding">{money(info.outstanding)}</Figure>
                <Figure label="Credit days">
                  {info.creditDays}
                  {info.creditDaysIsDefault ? " (default)" : ""}
                </Figure>
              </InfoRow>

              <div className="mt-3">
                <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Last 3 calls
                </span>
                {info.recentCalls.length ? (
                  <div className="mt-1">
                    {info.recentCalls.map((c) => (
                      <div key={c.id} className="border-b border-divider py-1.5 last:border-0">
                        <div className="text-[13px] text-body">
                          {shortDate(c.at.slice(0, 10))} ·{" "}
                          {c.outcome ? (OUTCOME_LABEL[c.outcome] ?? c.outcome) : "—"}
                        </div>
                        {c.notes ? (
                          <div className="text-[13px] text-muted">{c.notes}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[13px] text-muted">
                    No calls logged against this customer yet. The first one you save
                    appears here.
                  </p>
                )}
              </div>

              <div className="mt-3">
                <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Order status
                </span>
                <span className="ml-1.5 text-[11px] text-muted">
                  {info.productHistorySource === "external"
                    ? "From ERP · read-only"
                    : "From orders captured in the CRM — the ERP is not connected"}
                </span>
                {info.productHistory.length ? (
                  <div className="mt-1">
                    {info.productHistory.map((p) => (
                      <div
                        key={p.productName}
                        className="flex items-center gap-3 border-b border-divider py-1.5 text-[13px] last:border-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-body">
                          {p.productName}
                        </span>
                        <span className="text-muted">
                          {p.lastPurchaseDate ? shortDate(p.lastPurchaseDate) : "—"}
                        </span>
                        <span className="w-8 text-right text-ink">{p.totalOrderCount}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 rounded-[4px] border border-line px-3 py-5 text-center text-sm text-muted">
                    No ERP order history for this customer yet. It appears once the
                    office raises their first order.
                  </p>
                )}
              </div>
            </>
            ) : (
              <p className="text-[13px] text-muted">Loading this customer&rsquo;s history…</p>
            )}

          </div>

          <div
            className={cx(
              "h-full min-h-0 overflow-y-auto p-5",
              tab === "script" ? "block" : "hidden",
            )}
          >
            {script ? (
              <>
                <div className="text-[15px] font-semibold text-ink">{script.title}</div>
                <p className="mt-2 text-sm leading-[22px] whitespace-pre-wrap text-body">
                  {script.body}
                </p>
              </>
            ) : (
              <div className="rounded-[4px] border border-dashed border-line px-3 py-6 text-center">
                <p className="text-sm text-muted">
                  No script has been written for this situation yet.
                </p>
                <a href="/crm/help" className="mt-1 inline-block text-[13px] text-brand">
                  Open the Help Center
                </a>
              </div>
            )}
            <a
              href="/crm/help"
              className="mt-4 inline-block text-[13px] text-brand"
            >
              More scripts and procedures →
            </a>
          </div>

          <div
            className={cx(
              "h-full min-h-0 overflow-y-auto px-6 py-5",
              tab === "log" ? "block" : "hidden",
            )}
          >
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
            {script ? (
              <div className="mb-3 rounded-[4px] border border-line bg-canvas px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    {script.title}
                  </span>
                  <span className="flex-1" />
                  <button
                    onClick={() => setTab("script")}
                    className="cursor-pointer text-[13px] text-brand"
                  >
                    Read full script →
                  </button>
                </div>
                <p className="mt-1 line-clamp-2 text-[13px] text-body">{script.body}</p>
              </div>
            ) : null}

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
                <Input
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                  placeholder={`Search ${products.length} products by name or code`}
                  className="mt-2"
                />

                {needsProducts && !onThisOrder.length ? (
                  <div className="mt-2 rounded-[4px] border border-dashed border-warn-line bg-warn-soft px-3 py-5 text-center text-sm text-warn-ink">
                    At least one product is needed to log this as an order. Search above,
                    or tap one this customer usually buys.
                  </div>
                ) : null}

                {onThisOrder.length ? (
                  <div className="mt-2 rounded-[4px] border border-brand-softer bg-brand-soft px-3 py-2">
                    <span className="text-[11px] font-medium tracking-[0.04em] text-[#5223E0] uppercase">
                      On this order
                    </span>
                    <div className="mt-1 flex flex-col gap-0.5">
                      {onThisOrder.map((l) => (
                        <span key={l.product.id} className="text-[13px] text-ink">
                          {productLabel(l.product)} × {l.qty}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-2 max-h-56 overflow-y-auto rounded-[4px] border border-line">
                  {matches.length === 0 ? (
                    <p className="px-3 py-6 text-center text-[13px] text-muted">
                      No product matches that. Try the family name, like
                      &ldquo;epoxy&rdquo;, or the pack size.
                    </p>
                  ) : null}
                  {matches.map((p) => (
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
                        placeholder="Qty"
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
              hint="Quick notes add to this — you can still edit or type your own."
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
        </div>

        {/* ------------------------------------------------------- footer */}
        <div className="flex items-center gap-2.5 border-t border-divider px-6 py-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasPrevious}
            title={hasPrevious ? "Previous customer" : "This is the first row"}
            onClick={() => onPrevious?.()}
          >
            ◀ Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasNext}
            title={hasNext ? "Next customer" : "This is the last row"}
            onClick={() => onNext?.()}
          >
            Next ▶
          </Button>
          {position ? (
            <span className="text-[13px] text-muted">{position}</span>
          ) : null}
          <span className="flex-1" />
          {tab !== "log" ? (
            // From Information or Script, the way back to the job is one click.
            <Button variant="primary" onClick={() => setTab("log")}>
              Log this call ▸
            </Button>
          ) : chosen && !saved ? (
            <>
              <Button variant="primary" disabled={busy} onClick={() => save(false)}>
                Save log
              </Button>
              {hasNext ? (
                <Button variant="secondary" disabled={busy} onClick={() => save(true)}>
                  Save &amp; next ▸
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-[13px] text-muted">
              {saved ? "Saved" : "Pick how the interaction happened to begin"}
            </span>
          )}
        </div>
      </div>
    </div>

  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <div className="mt-1 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-1.5">
        {children}
      </div>
    </div>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="block">
      <span className="block text-[11px] text-muted">{label}</span>
      <span className="block text-[13px] font-medium text-ink">{children}</span>
    </span>
  );
}

/** One figure in the header strip. */
function Stat({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <span className="block min-w-0">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span
        className={cx(
          "block truncate text-sm font-medium",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {children}
      </span>
    </span>
  );
}
