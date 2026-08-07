"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Field,
  Input,
  Radio,
  Select,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { useEscape } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { saveInteractionAction } from "@/lib/actions/crm";
import {
  OUTCOMES_BY_TYPE,
  OUTCOME_LABEL as CATALOGUE_OUTCOME_LABEL,
} from "@/db/catalogue";
import { addDays, money, phoneDisplay, shortDate, today } from "@/lib/format";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/storage";

/**
 * The dates customers actually ask for, as one tap each. Anything else still
 * goes through the picker underneath.
 */
const FOLLOW_UP_PRESETS = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
  { label: "In 2 weeks", days: 14 },
] as const;

/** The queue's reason kinds, as the badge on the modal header reads them. */
const REASON_BADGE: Record<string, string> = {
  reminderOverdue: "Reminder overdue",
  reminderDueToday: "Reminder due today",
  orderOverdueFullCycle: "Order overdue",
  orderDue: "Order due",
  orderDueSoon: "Order due soon",
  prospect: "Never ordered",
  checkInOverdue: "Check-in overdue",
  checkInDue: "Check-in due",
};

const REASON_TONE: Record<string, "danger" | "warn" | "brand" | "neutral"> = {
  reminderOverdue: "danger",
  reminderDueToday: "warn",
  orderOverdueFullCycle: "danger",
  orderDue: "brand",
  orderDueSoon: "brand",
  prospect: "brand",
  checkInOverdue: "warn",
  checkInDue: "neutral",
};

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
  /** A lead has never ordered. It changes what the modal can truthfully show. */
  kind?: "lead" | "customer";
  reason?: string;
  /** The engine's kind for the top reason, shown as the badge on the right. */
  reasonKind?: string;
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

export type InteractionType =
  "outbound_call" | "inbound_call" | "order_received";

export type QuickNoteOption = {
  id: string;
  interactionType: InteractionType;
  outcome: string | null;
  label: string;
};

export type ProductOption = {
  id: string;
  name: string;
  packSize: string | null;
};

/** A call script from the help centre, matched to the chosen outcome. */
export type ScriptOption = {
  id: string;
  title: string;
  /** The words to say. */
  body: string;
  /** Why it is written this way — shown under the chips. */
  guidance: string;
  /** Which outcome it belongs to; null means it applies generally. */
  outcome: string | null;
};

/**
 * A script rendered as the design shows it: labelled blocks of lines, each
 * line split so a {placeholder} can be styled apart from the words around it.
 * Someone reading this aloud needs to see instantly what to substitute.
 */
function scriptBlocks(script: ScriptOption) {
  const parts = (line: string) =>
    line
      .split(/(\{[^}]+\})/g)
      .filter(Boolean)
      .map((text) => ({ text, placeholder: text.startsWith("{") }));

  const blocks: Array<{ label: string; lines: string[] }> = [];
  const said = script.body.split(/\n\s*\n/).filter((p) => p.trim());
  said.forEach((para, i) => {
    blocks.push({
      label: i === 0 ? "Say this" : "Then",
      lines: para.split("\n").filter(Boolean),
    });
  });
  if (script.guidance.trim()) {
    blocks.push({
      label: "Why it is written this way",
      lines: script.guidance.split(/\n+/).filter(Boolean),
    });
  }
  return blocks.map((b) => ({ ...b, parsed: b.lines.map(parts) }));
}

/** §7 — what the information strip shows. Derived server-side. */
export type CustomerInfo = {
  kind: "lead" | "customer";
  lead: {
    source: string | null;
    addedDate: string;
    ownerName: string | null;
  } | null;
  accountManagers: { sales: string | null; backOffice: string | null } | null;
  /** Null on a lead: no orders means no cycle and no target. */
  purchase: {
    lastOrderDate: string | null;
    lastOrderDaysAgo: number | null;
    cycleDays: number;
    cycleIsDefault: boolean;
    nextOrderDate: string | null;
    lastCallDate: string | null;
    lastCallDaysAgo: number | null;
  } | null;
  monthly: {
    target: number;
    achieved: number;
    achievementPercent: number;
    gap: number;
    workingDaysRemaining: number;
    requiredPerDay: number;
    shortfallPerDay: number;
  } | null;
  outstanding: number;
  creditDays: number;
  recentCalls: Array<{
    id: string;
    at: string;
    outcome: string | null;
    notes: string | null;
  }>;
  /** Newest first — what a Request CN on a complaint picks its bill from. */
  bills: Array<{ id: string; billNo: string; billDate: string }>;
  /** §2.1 — ranked and trimmed on the server, per configuration. */
  frequentProducts: Array<{
    productId: string;
    name: string;
    packSize: string | null;
    displayName: string;
    lastPurchaseDate: string | null;
    totalOrderCount: number;
  }>;
  productHistory: Array<{
    productName: string;
    lastPurchaseDate: string | null;
    totalOrderCount: number;
  }>;
  productHistorySource: "external" | "crm";
};

const TYPES: Array<{
  key: InteractionType;
  label: string;
  sub: string;
  icon: string;
}> = [
  {
    key: "outbound_call",
    label: "We Called Them",
    sub: "An outbound call you made",
    icon: "phone",
  },
  {
    key: "inbound_call",
    label: "They Called Us",
    sub: "The customer rang in",
    icon: "phone",
  },
  {
    key: "order_received",
    label: "Order Received",
    sub: "Arrived by WhatsApp or ERP — no call",
    icon: "doc",
  },
];

/**
 * Which outcomes a call may end in, and what they are called. Both come from
 * the catalogue, which is also what `saveInteraction` validates against — a
 * second copy here is a form that offers an outcome the server refuses.
 */
const OUTCOMES = OUTCOMES_BY_TYPE;

/** Widened, because past interactions arrive from the database as strings. */
const OUTCOME_LABEL: Record<string, string> = CATALOGUE_OUTCOME_LABEL;

type CallPanelProps = {
  target: CallTarget | null;
  quickNotes: QuickNoteOption[];
  products: ProductOption[];
  complaintCategories: Array<{ value: string; label: string }>;
  scripts?: ScriptOption[];
  /** Products this customer has bought before — the "Usually buys" row. */
  frequentProductIds?: string[];
  /** §3.2 — outcomes whose quick notes are one choice, from configuration. */
  singleSelectOutcomes?: string[];
  onClose: () => void;
  onSaved?: (advance: boolean) => void;
  hasNext?: boolean;
  hasPrevious?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  /** "3 of 12" — where this customer sits in the queue. */
  position?: string;
  /** Total worked, for the end-of-run summary. */
  queueTotal?: number;
  /** True once the last row has been worked. */
  queueComplete?: boolean;
};

type FormProps = CallPanelProps & {
  tab: "log" | "information" | "script";
  setTab: (t: "log" | "information" | "script") => void;
};

/**
 * Keyed on the customer, so moving to the next call always opens a blank form.
 * Carrying one customer's outcome into the next is the worst bug this screen
 * could have.
 */
export function CallPanel(props: CallPanelProps) {
  // The form is keyed on the customer so an outcome can never carry over. The
  // TAB is not — stepping to the next customer while reading Information
  // should leave you on Information, not throw you back a tab.
  const [tab, setTab] = React.useState<"log" | "information" | "script">(
    "information",
  );
  if (!props.target) return null;
  return (
    <CallPanelForm
      key={props.target.customerId}
      {...props}
      tab={tab}
      setTab={setTab}
    />
  );
}

function CallPanelForm({
  target,
  quickNotes,
  products,
  complaintCategories,
  scripts = [],
  frequentProductIds = [],
  singleSelectOutcomes = [],
  onClose,
  onSaved,
  hasNext,
  hasPrevious,
  onPrevious,
  onNext,
  position,
  queueTotal,
  queueComplete,
  tab,
  setTab,
}: FormProps) {
  useEscape(onClose);
  const router = useRouter();
  const { run, push } = useToast();

  const [type, setType] = React.useState<InteractionType | null>(null);
  const [outcome, setOutcome] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [quantities, setQuantities] = React.useState<Record<string, string>>(
    {},
  );
  const [followUpDate, setFollowUpDate] = React.useState("");
  const [payDate, setPayDate] = React.useState("");
  const [category, setCategory] = React.useState(
    complaintCategories[0]?.value ?? "other",
  );
  // The complaint, captured mid-call exactly as the complaints screen captures
  // one raised any other way — same description, same photos, same CN request.
  const [complaintDescription, setComplaintDescription] = React.useState("");
  const [complaintImages, setComplaintImages] = React.useState<File[]>([]);
  const [imageError, setImageError] = React.useState<string | null>(null);
  const [requestCn, setRequestCn] = React.useState(false);
  const [cnBillId, setCnBillId] = React.useState("");
  const [goodsDescription, setGoodsDescription] = React.useState("");
  const [orderDate, setOrderDate] = React.useState(today());
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saved, setSaved] = React.useState<string | null>(null);
  // Opens on Information: read who you are about to speak to before speaking.
  // "Log this call" in the footer is the way through to the form.
  // The strip starts open — a telecaller mid-call should not have to expand
  // something to see the line they are about to say.
  const [stripOpen, setStripOpen] = React.useState(true);
  const [productQuery, setProductQuery] = React.useState("");
  // The design caps the visible list and offers the rest behind "show more" —
  // a full catalogue scrolling under the cursor mid-call is unusable.
  const [showAllProducts, setShowAllProducts] = React.useState(false);

  // One key per opening, so a double-click logs one interaction, not two.
  const idempotencyKey = React.useRef(crypto.randomUUID());

  // The information strip loads with the panel rather than being prefetched
  // for every row behind it — most rows are never opened.
  const [info, setInfo] = React.useState<CustomerInfo | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    fetch(`/api/customer-info?customerId=${target.customerId}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : { info: null }))
      .then((d) => setInfo(d.info))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [target]);

  // §2.2 — search runs on the server so a misspelling still finds the
  // product. Debounced, because this fires on every keystroke mid-call.
  // The result is tagged with the query that produced it, so a stale response
  // is ignored on read rather than cleared by a second render pass — the
  // React Compiler rules exist to stop exactly that kind of effect.
  const [remote, setRemote] = React.useState<{
    q: string;
    items: ProductOption[];
  } | null>(null);
  React.useEffect(() => {
    const q = productQuery.trim();
    if (!q || !target) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/product-search?q=${encodeURIComponent(q)}&customerId=${target.customerId}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? r.json() : { products: [] }))
        .then((d) =>
          setRemote({
            q,
            items: (d.products ?? []).map(
              (x: { productId: string; name: string; packSize: string | null }) => ({
                id: x.productId,
                name: x.name,
                packSize: x.packSize,
              }),
            ),
          }),
        )
        // A dead search falls back to filtering what is already loaded rather
        // than leaving the telecaller with an empty list.
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [productQuery, target]);

  const isOrderReceived = type === "order_received";
  const chosen = isOrderReceived || Boolean(outcome);

  const needsProducts = isOrderReceived || outcome === "order_taken";
  const needsFollowUp = outcome === "follow_up";
  const needsPayDate =
    type === "inbound_call" && outcome === "payment_promised";
  const showPayDate = outcome === "payment_promised";
  const needsCategory = outcome === "complaint";

  /** The bill a requested credit note is against, for the read-only date. */
  const cnBill = (info?.bills ?? []).find((b) => b.id === cnBillId) ?? null;

  const chips = React.useMemo(
    () =>
      quickNotes.filter(
        (n) =>
          n.interactionType === type &&
          (n.outcome ?? null) === (outcome ?? null),
      ),
    [quickNotes, type, outcome],
  );

  // §3.2 — which outcomes take one reason rather than several is configuration,
  // not a property of each note: two rows for the same outcome could otherwise
  // disagree about it.
  const singleSelect = Boolean(outcome && singleSelectOutcomes.includes(outcome));

  // The script follows the outcome once one is chosen; before that, whatever
  // general guidance exists.
  const [scriptId, setScriptId] = React.useState<string | null>(null);

  // The script follows the outcome unless the telecaller has picked another.
  const matchedScript =
    scripts.find((x) => x.outcome && x.outcome === outcome) ??
    scripts[0] ??
    null;
  const script = scriptId
    ? (scripts.find((x) => x.id === scriptId) ?? matchedScript)
    : matchedScript;

  // No script covers this outcome — say so rather than showing a general one
  // as though it were written for the situation.
  const scriptMissing = Boolean(
    outcome && !scripts.some((x) => x.outcome === outcome),
  );

  // §2.1 — the server ranks and trims this per configuration. The prop is the
  // fallback for the moment before the information strip lands.
  const frequent: ProductOption[] = info?.frequentProducts?.length
    ? info.frequentProducts.map((f) => ({
        id: f.productId,
        name: f.name,
        packSize: f.packSize,
      }))
    : products.filter((p) => frequentProductIds.includes(p.id));
  const productLabel = (p: ProductOption) =>
    p.packSize ? `${p.name} — ${p.packSize}` : p.name;

  // A real catalogue is far too long to scroll mid-call, so the list is
  // searchable by name, pack size or code.
  const matches = React.useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return products;
    if (remote && remote.q === productQuery.trim()) return remote.items;
    return products.filter((p) =>
      `${p.name} ${p.packSize ?? ""}`.toLowerCase().includes(q),
    );
  }, [products, productQuery, remote]);

  // Long lists are capped until asked for — the design shows a handful and
  // keeps the rest one click away.
  const PRODUCT_PREVIEW = 8;
  const visibleProducts =
    showAllProducts || matches.length <= PRODUCT_PREVIEW
      ? matches
      : matches.slice(0, PRODUCT_PREVIEW);
  const hasMoreProducts = visibleProducts.length < matches.length;

  // What has actually been put on the order, read back so nothing is added by
  // accident and left unnoticed.
  const onThisOrder = products
    .map((p) => ({ product: p, qty: Number(quantities[p.id]) }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0);

  function applyChip(n: QuickNoteOption) {
    if (singleSelect) {
      // §3.3 — one reason, not a pile of them. A second pick REPLACES the
      // first in the stored identifier and in the text, so the note cannot
      // end up reading "Stock sufficient Price issue" and meaning neither.
      const previous = chips.find((c) => picked.includes(c.id));
      setPicked([n.id]);
      setNotes((t) => {
        const text = t.trim();
        if (!previous) return text ? `${text} ${n.label}` : n.label;
        // Swap the old label out wherever the telecaller left it. Anything
        // they typed themselves is theirs and survives untouched.
        const swapped = text.replace(previous.label, n.label);
        return swapped === text && !text.includes(n.label)
          ? text
            ? `${text} ${n.label}`
            : n.label
          : swapped;
      });
      return;
    }

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
          complaintDescription: needsCategory
            ? complaintDescription
            : undefined,
          complaintRequestCn: needsCategory ? requestCn : false,
          complaintBillId: needsCategory && requestCn ? cnBillId : undefined,
          complaintGoodsDescription:
            needsCategory && requestCn ? goodsDescription : undefined,
          complaintImages: needsCategory ? complaintImages : undefined,
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
        setErrors(
          Object.fromEntries(
            result.fieldErrors.map((f) => [f.field, f.message]),
          ),
        );
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
    // One customer's complaint must never be attached to the next one.
    setComplaintDescription("");
    setComplaintImages([]);
    setImageError(null);
    setRequestCn(false);
    setCnBillId("");
    setGoodsDescription("");
    setOrderDate(today());
    setErrors({});
    setSaved(null);
    idempotencyKey.current = crypto.randomUUID();
  }

  if (!target) return null;

  // The Reminder figure carries the reminder, not whatever reason put them in
  // the queue. Showing "Order due today" under a heading that says Reminder is
  // how a telecaller ends up looking for a promise nobody made.
  const isLead = target.kind === "lead";

  const reminderText =
    target.reasonKind === "reminderOverdue" ||
    target.reasonKind === "reminderDueToday"
      ? target.reason
      : null;

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
            <div className="flex items-center gap-2.5">
              <span className="text-[22px] leading-7 font-semibold text-ink">
                {target.name}
              </span>
              {isLead ? <Badge tone="brand">Lead</Badge> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              <span>{target.contactPerson}</span>
              <span>·</span>
              <a
                href={`tel:${target.phone}`}
                className="font-medium text-ink no-underline"
              >
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
            className="inline-flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
          >
            <Icon name="close" size={14} strokeWidth={1.8} />
          </button>
        </div>

        {/* What a telecaller needs before they speak.
            A row with dividers rather than a grid, because the figures are not
            all present: an empty "Open complaint — None" column takes space to
            say nothing, and reads as a thing to check when it is not. Each
            figure appears only when it has something to report. */}
        <div className="flex items-center gap-5 overflow-hidden border-y border-divider bg-canvas px-6 py-2.5">
          {/* A lead and a customer are different conversations, so the strip
              carries different facts. Outstanding and target gap on a record
              that has never ordered would both read zero, which looks like a
              customer doing badly rather than one who has not started. */}
          {isLead ? (
            <>
              <Stat label="Lead owner">
                {info?.lead?.ownerName ?? "Unassigned"}
              </Stat>
              <StatDivider />
              <Stat label="Added">
                {info?.lead ? shortDate(info.lead.addedDate) : "—"}
              </Stat>
              <StatDivider />
              <Stat label="Source">{info?.lead?.source ?? "Not recorded"}</Stat>
            </>
          ) : (
            <>
              <Stat label="Account manager · sales">
                {info?.accountManagers?.sales ??
                  target.ownerName ??
                  "Unassigned"}
              </Stat>
              <StatDivider />
              {/* Unassigned back office is worth flagging: dispatch and billing
                  questions on this call have nobody to go to. */}
              <Stat
                label="Account manager · back office"
                tone={
                  info && !info.accountManagers?.backOffice ? "warn" : undefined
                }
              >
                {info?.accountManagers?.backOffice ?? "Unassigned"}
              </Stat>
              <StatDivider />
              <Stat
                label="Outstanding"
                tone={target.outstanding > 0 ? "danger" : undefined}
              >
                {money(target.outstanding)}
              </Stat>
              <StatDivider />
              <Stat label="Target gap">{money(target.targetGap)}</Stat>
            </>
          )}
          {reminderText ? (
            <>
              <StatDivider />
              <Stat label="Reminder" tone="warn" shrink>
                {reminderText}
              </Stat>
            </>
          ) : null}
          {target.openComplaint ? (
            <>
              <StatDivider />
              {/* Clickable: the complaint is the thing to raise first, so it
                  jumps to it rather than only announcing that it exists. */}
              <button
                onClick={() => setTab("information")}
                title={target.openComplaint}
                className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-sm font-medium whitespace-nowrap text-danger"
              >
                Open complaint
              </button>
            </>
          ) : null}
          <span className="flex-1" />
          {/* Why this customer is in front of you, in the queue's own words. */}
          {target.reasonKind ? (
            <Badge tone={REASON_TONE[target.reasonKind] ?? "neutral"}>
              {(
                REASON_BADGE[target.reasonKind] ?? target.reasonKind
              ).toUpperCase()}
            </Badge>
          ) : null}
        </div>

        {/* --------------------------------------- information | the form */}
        {queueComplete ? (
          // The last row has been worked. The design ends the run here rather
          // than dropping the telecaller back onto an empty list.
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-[420px] text-center">
              <div className="text-[22px] leading-7 font-semibold text-ink">
                Queue complete
              </div>
              <p className="mt-1.5 text-[15px] text-muted">
                {queueTotal
                  ? `${queueTotal} of ${queueTotal} customers worked today.`
                  : "Every customer due today has been worked."}
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
                <a
                  href="/crm/payments"
                  className="inline-flex h-9 items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline"
                >
                  Go to payment follow-up ▸
                </a>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* ---------------------------------------------------- the tabs */}
            <div className="flex items-center gap-1 border-b border-divider px-6">
              {[
                { key: "information" as const, label: "Information" },
                { key: "log" as const, label: "Call log" },
                { key: "script" as const, label: "Script" },
              ].map((t) => (
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
                  // No padding here — the Information sections are full-bleed and
                  // separated by rules, so they carry their own.
                  "h-full min-h-0 overflow-y-auto",
                  tab === "information" ? "block" : "hidden",
                )}
              >
                {loading ? (
                  // Only this pane waits — the tabs and the form stay put, so
                  // stepping to the next customer does not blank the modal.
                  <div className="p-6">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className="mb-3 flex items-center gap-3 last:mb-0"
                      >
                        <span className="block h-2.5 w-[180px] rounded-[2px] bg-divider" />
                        <span className="block h-2.5 w-[120px] rounded-[2px] bg-divider" />
                        <span className="flex-1" />
                        <span className="block h-2.5 w-[90px] rounded-[2px] bg-divider" />
                      </div>
                    ))}
                  </div>
                ) : info ? (
                  <>
                    {info.lead ? (
                      <div className="border-b border-divider px-6 py-4">
                        <p className="rounded-[4px] border border-brand-softer bg-brand-soft px-3.5 py-3 text-sm leading-[21px] text-ink">
                          This is a lead — nobody here has ordered yet. There is
                          no buying cycle, outstanding or monthly target to work
                          from, so the call is about finding out what they use
                          and what it would take to win the first order.
                          {info.lead.source
                            ? ` Came in through ${info.lead.source}.`
                            : ""}
                        </p>
                      </div>
                    ) : null}

                    {/* Three columns, not four: the design folds the next expected
                  order into the purchase cycle as its sub-line, because the
                  cycle is what predicts the date and reading them apart makes
                  the reader do the arithmetic. */}
                    {info.purchase && info.monthly ? (
                      <>
                        <InfoSection label="Purchase summary">
                          <Figure
                            label="Last order"
                            value={
                              info.purchase.lastOrderDate
                                ? shortDate(info.purchase.lastOrderDate)
                                : "Never"
                            }
                            sub={
                              info.purchase.lastOrderDaysAgo === null
                                ? "No order recorded"
                                : daysAgoLabel(info.purchase.lastOrderDaysAgo)
                            }
                          />
                          <Figure
                            label="Purchase cycle"
                            value={`${info.purchase.cycleDays} days`}
                            sub={
                              info.purchase.nextOrderDate
                                ? `Next order: ${shortDate(info.purchase.nextOrderDate)}`
                                : info.purchase.cycleIsDefault
                                  ? "Default — too little history"
                                  : "No order to count from"
                            }
                            subTone="brand"
                          />
                          <Figure
                            label="Last call"
                            value={
                              info.purchase.lastCallDate
                                ? shortDate(info.purchase.lastCallDate)
                                : "Never"
                            }
                            sub={
                              info.purchase.lastCallDaysAgo === null
                                ? "Never spoken to"
                                : daysAgoLabel(info.purchase.lastCallDaysAgo)
                            }
                          />
                        </InfoSection>

                        <InfoSection label="Monthly performance">
                          {/* The percentage leads and the rupees explain it. A target of
                    ₹2,47,079 tells you nothing on its own; 0% does. */}
                          <Figure
                            label="Monthly target"
                            value={`${info.monthly.achievementPercent}%`}
                            sub={`${money(info.monthly.achieved)} achieved`}
                          />
                          <Figure
                            label="Target gap this month"
                            value={money(info.monthly.gap)}
                            sub={`${info.monthly.workingDaysRemaining} working days left`}
                          />
                          {/* Boxed, and tinted when behind — this is the one figure on
                    the tab that says do something differently today. */}
                          <div
                            className={cx(
                              "rounded-[4px] border px-2.5 py-2",
                              info.monthly.shortfallPerDay > 0
                                ? "border-danger-soft bg-danger-soft"
                                : "border-line bg-canvas",
                            )}
                          >
                            <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                              Run rate
                            </span>
                            <span
                              className={cx(
                                "mt-0.5 block text-lg leading-6 font-semibold",
                                info.monthly.shortfallPerDay > 0
                                  ? "text-warn-ink"
                                  : "text-ink",
                              )}
                            >
                              {info.monthly.shortfallPerDay > 0
                                ? `Short by ${money(info.monthly.shortfallPerDay)}/day`
                                : "On track"}
                            </span>
                            <span className="block text-[13px] text-body">
                              Need {money(info.monthly.requiredPerDay)}/day
                            </span>
                          </div>
                        </InfoSection>
                      </>
                    ) : null}

                    {/* No heading in the design — two figures that need no naming as
                  a group, and a heading would only add a line. */}
                    <InfoSection>
                      <Figure
                        label="Outstanding"
                        value={money(info.outstanding)}
                        tone={info.outstanding > 0 ? "danger" : undefined}
                      />
                      <Figure
                        label="Credit days"
                        value={`${info.creditDays} days`}
                      />
                    </InfoSection>

                    <InfoSection label="Last 3 calls" plain>
                      {info.recentCalls.length ? (
                        info.recentCalls.map((c) => (
                          <div
                            key={c.id}
                            className="flex gap-3 border-t border-canvas py-2 first:border-0"
                          >
                            <span className="w-[58px] flex-none text-[13px] font-medium text-ink">
                              {shortDate(c.at.slice(0, 10))}
                            </span>
                            <span className="min-w-0 flex-1">
                              <Badge tone={outcomeTone(c.outcome)}>
                                {c.outcome
                                  ? (OUTCOME_LABEL[c.outcome] ?? c.outcome)
                                  : "Logged"}
                              </Badge>
                              {c.notes ? (
                                <span
                                  title={c.notes}
                                  className="mt-[3px] block truncate text-[13px] text-muted"
                                >
                                  {c.notes}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="py-4 text-sm text-muted">
                          No calls logged against this customer yet. The first
                          one you save appears here.
                        </p>
                      )}
                    </InfoSection>

                    <div className="px-6 py-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
                          Order status
                        </span>
                        {/* The design's chip says "From ERP · read-only". Ours says
                      where the rows actually came from, because the ERP is not
                      connected and a chip claiming otherwise would be a lie
                      about the freshness of the numbers underneath it. */}
                        <span className="inline-flex h-5 items-center rounded-[4px] border border-line bg-canvas px-1.5 text-[11px] font-medium text-muted">
                          {info.productHistorySource === "external"
                            ? "From ERP · read-only"
                            : "From CRM orders · ERP not connected"}
                        </span>
                      </div>
                      {info.productHistory.length ? (
                        <div className="overflow-hidden rounded-[4px] border border-line">
                          {info.productHistory.map((p) => (
                            <div
                              key={p.productName}
                              className="flex items-center gap-3 border-b border-divider px-3 py-2 last:border-0"
                            >
                              <span
                                className="min-w-0 flex-1 truncate text-sm text-ink"
                                title={p.productName}
                              >
                                {p.productName}
                              </span>
                              <span className="flex-none text-[13px] text-muted">
                                {p.lastPurchaseDate
                                  ? shortDate(p.lastPurchaseDate)
                                  : "—"}
                              </span>
                              <span className="w-[78px] flex-none text-right text-[13px] font-medium text-ink">
                                {p.totalOrderCount}
                                {p.totalOrderCount === 1 ? " order" : " orders"}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="rounded-[4px] border border-line px-3 py-5 text-center text-sm text-muted">
                          No order history for this customer yet. It appears
                          once an order is captured against them.
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="p-6 text-[13px] text-muted">
                    Nothing recorded against this customer yet.
                  </p>
                )}
              </div>

              <div
                className={cx(
                  "h-full min-h-0 overflow-y-auto p-5",
                  tab === "script" ? "block" : "hidden",
                )}
              >
                {scripts.length ? (
                  <div className="-mx-5 -mt-5 mb-4 border-b border-divider px-5 py-3.5">
                    <div className="flex flex-wrap gap-1.5">
                      {scripts.map((x) => (
                        <button
                          key={x.id}
                          onClick={() => setScriptId(x.id)}
                          className={cx(
                            "cursor-pointer rounded-full border px-2.5 py-1 text-[13px]",
                            script?.id === x.id
                              ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                              : "border-line bg-surface text-body hover:border-brand",
                          )}
                        >
                          {x.title}
                        </button>
                      ))}
                    </div>
                    {script?.guidance ? (
                      <p className="mt-2 text-[13px] text-muted">
                        {script.guidance.split(/\n+/)[0]}
                      </p>
                    ) : null}
                    {scriptMissing ? (
                      <div className="mt-2.5 rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
                        Nothing is written for{" "}
                        {OUTCOME_LABEL[outcome!] ?? "this outcome"} yet — this
                        is the closest script we have.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {script ? (
                  <div className="max-w-[420px]">
                    {scriptBlocks(script).map((b, bi) => (
                      <div key={bi} className="mb-4">
                        <span className="mb-1.5 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                          {b.label}
                        </span>
                        {b.parsed.map((line, li) => (
                          <div
                            key={li}
                            className="mb-1.5 text-base leading-7 text-ink"
                            style={{ textWrap: "pretty" }}
                          >
                            {line.map((part, pi) => (
                              <span
                                key={pi}
                                className={
                                  part.placeholder
                                    ? "rounded-[3px] bg-brand-soft px-1 font-medium text-[#5223E0]"
                                    : undefined
                                }
                              >
                                {part.text}
                              </span>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}
                    <a
                      href="/crm/help"
                      className="text-sm font-medium text-brand"
                    >
                      More scripts and procedures →
                    </a>
                  </div>
                ) : (
                  <div className="px-6 py-10 text-center">
                    <p className="text-[15px] text-muted">
                      No script has been written for this situation yet.
                    </p>
                    <a
                      href="/crm/help"
                      className="mt-3.5 inline-flex h-8.5 items-center rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
                    >
                      Open the Help Center
                    </a>
                  </div>
                )}
              </div>

              <div
                className={cx(
                  "h-full min-h-0 overflow-y-auto px-6 py-5",
                  tab === "log" ? "block" : "hidden",
                )}
              >
                <div className="mx-auto max-w-[720px]">
                  {saved ? (
                    <div className="rounded-[6px] border border-line bg-surface p-5 text-center">
                      <div className="text-lg font-semibold text-ink">
                        Log saved
                      </div>
                      <div className="mt-1 text-sm text-muted">{saved}</div>
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {hasNext ? (
                          <Button
                            variant="primary"
                            onClick={() => onSaved?.(true)}
                          >
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
                              <span className="block text-sm font-medium text-ink">
                                {t.label}
                              </span>
                              <span className="block text-[13px] text-muted">
                                {t.sub}
                              </span>
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
                            <button
                              onClick={() => setStripOpen((o) => !o)}
                              className="flex cursor-pointer items-center gap-1.5"
                            >
                              <Icon
                                name="chevron"
                                size={12}
                                className={cx(
                                  "text-muted transition-transform",
                                  stripOpen && "rotate-90",
                                )}
                              />
                              <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                                {script.title}
                              </span>
                            </button>
                            <span className="flex-1" />
                            <button
                              onClick={() => setTab("script")}
                              className="cursor-pointer text-[13px] text-brand"
                            >
                              Read full script →
                            </button>
                          </div>
                          {stripOpen ? (
                            <div className="mt-1.5">
                              {scriptBlocks(script)
                                .slice(0, 1)
                                .map((b, bi) => (
                                  <div key={bi}>
                                    {b.parsed.map((line, li) => (
                                      <div
                                        key={li}
                                        className="text-[13px] leading-5 text-body"
                                      >
                                        {line.map((part, pi) => (
                                          <span
                                            key={pi}
                                            className={
                                              part.placeholder
                                                ? "font-medium text-[#5223E0]"
                                                : undefined
                                            }
                                          >
                                            {part.text}
                                          </span>
                                        ))}
                                      </div>
                                    ))}
                                  </div>
                                ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="text-[15px] font-semibold text-ink">
                        What was the outcome?
                      </div>
                      <div className="mt-3 flex flex-col gap-2">
                        {OUTCOMES[
                          type as Exclude<InteractionType, "order_received">
                        ].map((o) => (
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
                        onClick={() =>
                          isOrderReceived ? setType(null) : setOutcome(null)
                        }
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
                          {/* "Call me tomorrow" and "call me after three days" are what
                    customers actually say, and both were three taps through a
                    date picker. The chips write the same date into the same
                    field, so the picker still wins for anything unusual. */}
                          <div className="mb-1.5 flex flex-wrap gap-1.5">
                            {FOLLOW_UP_PRESETS.map((preset) => {
                              const date = addDays(today(), preset.days);
                              return (
                                <button
                                  key={preset.label}
                                  type="button"
                                  onClick={() => setFollowUpDate(date)}
                                  className={cx(
                                    "h-7 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
                                    followUpDate === date
                                      ? "border-brand bg-brand-soft font-medium text-brand-hover"
                                      : "border-line bg-surface text-body hover:bg-canvas",
                                  )}
                                >
                                  {preset.label}
                                </button>
                              );
                            })}
                          </div>
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
                          label={
                            needsPayDate
                              ? "Payment date"
                              : "Payment date (optional)"
                          }
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
                        <Field
                          label="Complaint category"
                          error={errors.complaintCategory ?? null}
                        >
                          <Select
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                          >
                            {complaintCategories.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ) : null}

                      {needsCategory ? (
                        <>
                          <Field
                            label="Complaint description"
                            error={errors.complaintDescription ?? null}
                          >
                            <Textarea
                              value={complaintDescription}
                              onChange={(e) => {
                                setComplaintDescription(e.target.value);
                              }}
                              className="h-20"
                              placeholder="Describe the complaint in detail."
                            />
                          </Field>

                          <Field
                            label="Upload picture"
                            hint="JPG, JPEG, PNG or WEBP — photos of the damaged or short goods, if any."
                            error={imageError}
                          >
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(e) => {
                                const picked = Array.from(e.target.files ?? []);
                                const accepted = picked.filter((f) =>
                                  ACCEPTED_IMAGE_TYPES.includes(f.type),
                                );
                                setComplaintImages(accepted);
                                setImageError(
                                  accepted.length < picked.length
                                    ? "Only JPG, JPEG, PNG or WEBP images are allowed."
                                    : null,
                                );
                              }}
                              className="block w-full text-sm text-body file:mr-3 file:cursor-pointer file:rounded-[4px] file:border file:border-line file:bg-surface file:px-2.5 file:py-1.5 file:text-sm file:text-ink"
                            />
                            {complaintImages.length ? (
                              <p className="mt-1 text-[13px] text-muted">
                                {complaintImages.length} picture
                                {complaintImages.length === 1 ? "" : "s"} will be
                                attached
                              </p>
                            ) : null}
                          </Field>

                          <Field label="Request CN">
                            <div className="flex items-center gap-4">
                              <Radio
                                name="callRequestCn"
                                label="No"
                                checked={!requestCn}
                                onChange={() => setRequestCn(false)}
                              />
                              <Radio
                                name="callRequestCn"
                                label="Yes"
                                checked={requestCn}
                                onChange={() => setRequestCn(true)}
                              />
                            </div>
                          </Field>

                          {requestCn ? (
                            <div className="mb-3.5 grid gap-3 rounded-[4px] border border-line bg-canvas p-3">
                              <Field
                                label="Bill number"
                                error={errors.complaintBillId ?? null}
                              >
                                <Select
                                  value={cnBillId}
                                  onChange={(e) => setCnBillId(e.target.value)}
                                >
                                  <option value="">Select a bill</option>
                                  {(info?.bills ?? []).map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.billNo} · {shortDate(b.billDate)}
                                    </option>
                                  ))}
                                </Select>
                              </Field>

                              <Field label="Bill date">
                                <Input
                                  value={
                                    cnBill ? shortDate(cnBill.billDate) : ""
                                  }
                                  readOnly
                                  disabled
                                  placeholder="Pick a bill number first"
                                />
                              </Field>

                              <Field
                                label="Description of goods"
                                hint="Not on the bill record — filled in manually."
                              >
                                <Textarea
                                  value={goodsDescription}
                                  onChange={(e) =>
                                    setGoodsDescription(e.target.value)
                                  }
                                  className="h-16"
                                  placeholder="What was billed"
                                />
                              </Field>
                            </div>
                          ) : null}
                        </>
                      ) : null}

                      {needsProducts ? (
                        <div className="mb-3.5">
                          <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                            Products and quantity
                          </span>
                          {frequent.length ? (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              <span className="text-[13px] text-muted">
                                Usually buys
                              </span>
                              {frequent.map((p) => (
                                <button
                                  key={p.id}
                                  onClick={() =>
                                    setQuantities((q) => ({
                                      ...q,
                                      [p.id]: q[p.id] || "1",
                                    }))
                                  }
                                  className="cursor-pointer rounded-full border border-line bg-surface px-2.5 py-1 text-[13px] text-body hover:border-brand"
                                >
                                  {productLabel(p)}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <div className="relative mt-2">
                            <Input
                              value={productQuery}
                              onChange={(e) => setProductQuery(e.target.value)}
                              placeholder={`Search ${products.length} products by name or code`}
                            />
                            {productQuery ? (
                              <button
                                onClick={() => setProductQuery("")}
                                title="Clear the search"
                                className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-[13px] text-muted hover:text-body"
                              >
                                Clear
                              </button>
                            ) : null}
                          </div>

                          {needsProducts && !onThisOrder.length ? (
                            <div className="mt-2 rounded-[4px] border border-dashed border-warn-line bg-warn-soft px-3 py-5 text-center text-sm text-warn-ink">
                              At least one product is needed to log this as an
                              order. Search above, or tap one this customer
                              usually buys.
                            </div>
                          ) : null}

                          {onThisOrder.length ? (
                            <div className="mt-2 rounded-[4px] border border-brand-softer bg-brand-soft px-3 py-2">
                              <span className="text-[11px] font-medium tracking-[0.04em] text-[#5223E0] uppercase">
                                On this order
                              </span>
                              <div className="mt-1 flex flex-col gap-0.5">
                                {onThisOrder.map((l) => (
                                  <span
                                    key={l.product.id}
                                    className="text-[13px] text-ink"
                                  >
                                    {productLabel(l.product)} × {l.qty}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <div className="mt-2 max-h-56 overflow-y-auto rounded-[4px] border border-line">
                            {matches.length === 0 ? (
                              <p className="px-3 py-6 text-center text-[13px] text-muted">
                                No product matches that. Try the family name,
                                like &ldquo;epoxy&rdquo;, or the pack size.
                              </p>
                            ) : null}
                            {visibleProducts.map((p) => (
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
                                    setQuantities((q) => ({
                                      ...q,
                                      [p.id]: e.target.value,
                                    }))
                                  }
                                  placeholder="Qty"
                                  className="h-8 w-[70px] rounded-[4px] border border-line px-2 text-right text-sm"
                                />
                              </div>
                            ))}
                          </div>
                          {hasMoreProducts ? (
                            <button
                              onClick={() => setShowAllProducts(true)}
                              className="mt-1.5 cursor-pointer text-[13px] text-brand"
                            >
                              Show all {matches.length} matches
                            </button>
                          ) : null}
                          {errors.productQuantities ? (
                            <p className="mt-1 text-[13px] text-danger">
                              {errors.productQuantities}
                            </p>
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
            </div>
          </>
        )}

        {/* ------------------------------------------------------- footer */}
        <div className="flex items-center gap-2.5 border-t border-divider px-6 py-3">
          {/* Position first, then the steppers around a divider — the design's
              order, and it reads as one control rather than three. */}
          {position ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[13px] text-muted">{position}</span>
              <button
                disabled={!hasPrevious}
                title={
                  hasPrevious ? "Previous customer" : "This is the first row"
                }
                onClick={() => onPrevious?.()}
                className="h-8 cursor-pointer rounded-[4px] px-2 text-[13px] text-body hover:bg-canvas disabled:cursor-not-allowed disabled:text-line-strong"
              >
                ◀ Previous
              </button>
              <span className="text-line">|</span>
              <button
                disabled={!hasNext}
                title={hasNext ? "Next customer" : "This is the last row"}
                onClick={() => onNext?.()}
                className="h-8 cursor-pointer rounded-[4px] px-2 text-[13px] text-body hover:bg-canvas disabled:cursor-not-allowed disabled:text-line-strong"
              >
                Next ▶
              </button>
            </span>
          ) : null}

          {chosen && !saved ? (
            <button
              onClick={() =>
                isOrderReceived ? setType(null) : setOutcome(null)
              }
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 px-2.5 text-[13px] text-muted hover:text-body"
            >
              ◀ {isOrderReceived ? "Change type" : "Change outcome"}
            </button>
          ) : null}

          <span className="flex-1" />

          {saved ? (
            <span className="animate-fade-in text-sm font-medium text-success">
              Saved
            </span>
          ) : null}

          <Button variant="secondary" onClick={onClose}>
            {saved ? "Done" : "Close"}
          </Button>

          {tab !== "log" ? (
            <Button variant="primary" onClick={() => setTab("log")}>
              Log this call ▸
            </Button>
          ) : chosen && !saved ? (
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => save(false)}
              >
                Save log
              </Button>
              {hasNext ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => save(true)}
                >
                  Save &amp; next ▸
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One band of the Information tab: full-bleed, separated by a rule rather
 * than by whitespace, so a long tab still reads as a stack of distinct facts.
 * `plain` opts out of the figure grid for sections that lay out their own rows.
 */
function InfoSection({
  label,
  plain,
  children,
}: {
  label?: string;
  plain?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-divider px-6 py-4">
      {label ? (
        <div className="mb-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          {label}
        </div>
      ) : null}
      {plain ? (
        children
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-start gap-4">
          {children}
        </div>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  subTone,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subTone?: "brand";
  tone?: "danger";
}) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span
        className={cx(
          "mt-0.5 block text-lg leading-6 font-semibold",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </span>
      {sub ? (
        <span
          className={cx(
            "block text-xs",
            subTone === "brand" ? "font-medium text-brand-hover" : "text-muted",
          )}
        >
          {sub}
        </span>
      ) : null}
    </span>
  );
}

/**
 * "Today" / "1 day ago" / "27 days ago". Written out rather than "27d ago":
 * this tab is read aloud while the phone is ringing.
 */
function daysAgoLabel(days: number): string {
  if (days === 0) return "Today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Outcomes carry the same colour here as everywhere else in the CRM. */
function outcomeTone(outcome: string | null) {
  switch (outcome) {
    case "order_taken":
      return "success" as const;
    case "no_answer":
    case "not_interested":
      return "danger" as const;
    case "payment_promised":
    case "follow_up":
    case "complaint":
      return "warn" as const;
    default:
      return "neutral" as const;
  }
}

/** One figure in the header strip. */
function StatDivider() {
  return <span className="h-7 w-px flex-none bg-line" />;
}

/**
 * A figure in the strip above the tabs.
 *
 * Truncation is opt-in, and only free text ever opts in. A shortened name is
 * still a name, but "₹12,4…" is not a number — it could be twelve thousand or
 * twelve lakh, and a telecaller about to ask for money cannot tell which. So
 * the figures hold their full width and the long notes absorb the squeeze.
 */
function Stat({
  label,
  tone,
  shrink = false,
  children,
}: {
  label: string;
  tone?: "danger" | "warn";
  /** Free text that may be shortened when the strip runs out of room. */
  shrink?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={cx("block", shrink ? "min-w-0 shrink" : "shrink-0")}>
      <span className="block truncate text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span
        className={cx(
          "block text-sm font-medium",
          shrink ? "truncate" : "whitespace-nowrap",
          tone === "danger"
            ? "text-danger"
            : tone === "warn"
              ? "text-warn-ink"
              : "text-ink",
        )}
      >
        {children}
      </span>
    </span>
  );
}
