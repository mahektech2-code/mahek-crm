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
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog, useEscape } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { NextStepDialog } from "@/components/crm/next-step-dialog";
import { saveInteractionAction } from "@/lib/actions/crm";
import type { NextStep } from "@/lib/engines/next-step";
import {
  OUTCOMES_BY_TYPE,
  OUTCOME_LABEL as CATALOGUE_OUTCOME_LABEL,
} from "@/db/catalogue";
import {
  addDays,
  daysBetween,
  money,
  phoneDisplay,
  shortDate,
  today,
} from "@/lib/format";
import { describeQuantity } from "@/lib/catalogue";
import { addLabel, dropLabel } from "@/lib/notes";
import { ImagePicker } from "@/components/crm/image-picker";

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
  /**
   * The formulation. "Astar Nano Thinner - 20 Liter (Loose)" and "Nano Thinner
   * - 20 Liter (Loose)" are two products whose names differ by one word, and
   * mid-call the thing that tells them apart is what is underneath them.
   */
  subtitle?: string | null;
  /** Set when the row matched on something not visible in its name. */
  matchedOn?: string | null;
  /** Packing, so a quantity in cans can be read back in litres and boxes. */
  millilitresPerCan?: number | null;
  cansPerBox?: number | null;
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
function scriptBlocks(script: ScriptOption, fill: Record<string, string> = {}) {
  // A placeholder the CRM can answer is answered. Reading "am I speaking to
  // {contact name}?" aloud is a stumble the system could have prevented — it
  // knows the name. What it cannot fill stays in braces, as the thing to say
  // in your own words, and either way it keeps the highlight so the reader
  // can see at a glance which words are about this customer.
  const parts = (line: string) =>
    line
      .split(/(\{[^}]+\})/g)
      .filter(Boolean)
      .map((text) => {
        if (!text.startsWith("{")) {
          return { text, placeholder: false, resolved: false };
        }
        const key = text.slice(1, -1).trim().toLowerCase();
        const value = fill[key];
        // Resolved and unresolved are told apart on the screen. A real name
        // reads as part of the sentence; braces are an instruction to the
        // reader, and dressing the two identically means somebody says the
        // word "bill number" out loud on a live call.
        return {
          text: value ?? text,
          placeholder: true,
          resolved: value !== undefined,
        };
      });

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
    subtitle: string | null;
    millilitresPerCan: number | null;
    cansPerBox: number;
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
    sub: "Arrived by WhatsApp or ERP - no call",
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
  /**
   * `products.searchOnOrderForms`. Off, the catalogue is not searchable and a
   * telecaller picks from what they are offered — a deliberate constraint for
   * a new team. The box is then hidden rather than shown and made useless,
   * because a search box that finds nothing reads as a broken catalogue.
   */
  searchEnabled?: boolean;
  /** `products.searchMinChars` — below this, nothing is asked of the server. */
  searchMinChars?: number;
  /** The signed-in telecaller, so a script can say their name rather than {your name}. */
  userName?: string;
  /** §3.2 — outcomes whose quick notes are one choice, from configuration. */
  singleSelectOutcomes?: string[];
  /** `attachments.maxPerComplaint`, so the drawer and the server agree. */
  maxComplaintImages?: number;
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
  onLogged: (call: LoggedCall) => void;
};

/**
 * A call that has just been saved, held by the OUTER component.
 *
 * Everything here is captured at the moment of saving rather than read off
 * props afterwards, because by then the props have moved: saving revalidates
 * the page, the customer drops off the queue they were just worked from, and
 * `target` is gone before the answer has been read.
 */
type LoggedCall = {
  label: string;
  customerName: string;
  step: NextStep | null;
  /** Whether "Save & next" was the button. */
  wantsNext: boolean;
  /**
   * Whether this screen can move on at all — NOT whether a next row exists.
   * That is read at dismissal by the screen itself, because the queue has
   * already changed by then: the row just worked has dropped off it.
   */
  canAdvance: boolean;
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

  /*
   * "Saved — and here is what happens next" is held HERE, above the keyed
   * form, and deliberately outside the `target` guard.
   *
   * Saving a call revalidates the page, which is right — the queue has to lose
   * the customer who was just worked. But that also takes `target` away, and
   * with it the form, so a dialog rendered inside the form was unmounted in
   * the same frame it opened: the drawer simply shut and the answer was never
   * seen. Everything the dialog needs is captured at the moment of saving, so
   * it outlives the row it came from.
   */
  const router = useRouter();
  const [logged, setLogged] = React.useState<LoggedCall | null>(null);
  const [nextStepOpen, setNextStepOpen] = React.useState(false);

  function dismiss(advance: boolean) {
    setNextStepOpen(false);
    router.refresh();
    if (advance) props.onSaved?.(true);
  }

  return (
    <>
      {props.target ? (
        <CallPanelForm
          key={props.target.customerId}
          {...props}
          tab={tab}
          setTab={setTab}
          onLogged={(call) => {
            setLogged(call);
            setNextStepOpen(true);
          }}
        />
      ) : null}

      {logged ? (
        <NextStepDialog
          open={nextStepOpen}
          savedLabel={logged.label}
          step={logged.step}
          customerName={logged.customerName}
          defaultNext={logged.wantsNext}
          onNext={logged.canAdvance ? () => dismiss(true) : null}
          onStay={() => dismiss(false)}
        />
      ) : null}
    </>
  );
}

function CallPanelForm({
  target,
  quickNotes,
  products,
  complaintCategories,
  scripts = [],
  frequentProductIds = [],
  searchEnabled = true,
  searchMinChars = 2,
  userName,
  singleSelectOutcomes = [],
  maxComplaintImages = 6,
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
  onLogged,
}: FormProps) {
  useEscape(onClose);
  // No router here: the refresh belongs to the dialog's dismissal, one level
  // up, because doing it on save unmounts this component before the answer has
  // been read.
  const { run, push } = useToast();

  const [type, setType] = React.useState<InteractionType | null>(null);
  const [outcome, setOutcome] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [quantities, setQuantities] = React.useState<Record<string, string>>(
    {},
  );
  const [followUpDate, setFollowUpDate] = React.useState("");
  /* No order: the date the customer gave, or an explicit "they would not say". */
  const [noOrderNextCallDate, setNoOrderNextCallDate] = React.useState("");
  const [noOrderNoCommitment, setNoOrderNoCommitment] = React.useState(false);
  const [payDate, setPayDate] = React.useState("");
  const [category, setCategory] = React.useState(
    complaintCategories[0]?.value ?? "other",
  );
  // The complaint, captured mid-call exactly as the complaints screen captures
  // one raised any other way — same description, same photos, same CN request.
  const [complaintDescription, setComplaintDescription] = React.useState("");
  const [complaintImages, setComplaintImages] = React.useState<File[]>([]);
  const [requestCn, setRequestCn] = React.useState(false);
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
  const [showAllFrequent, setShowAllFrequent] = React.useState(false);
  /** The line a typed zero is asking to remove, if any. */
  const [removing, setRemoving] = React.useState<ProductOption | null>(null);

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
    if (!q || !target || !searchEnabled) return;
    // One character matches most of the catalogue, so it is a round trip whose
    // answer is unreadable. The local filter over what is already loaded still
    // runs, so the first keystroke is not dead — it just does not ask Postgres.
    if (q.length < searchMinChars) return;
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
              (x: {
                productId: string;
                name: string;
                packSize: string | null;
                subtitle?: string | null;
                matchedOn?: string | null;
                millilitresPerCan?: number | null;
                cansPerBox?: number | null;
              }) => ({
                id: x.productId,
                name: x.name,
                packSize: x.packSize,
                subtitle: x.subtitle,
                matchedOn: x.matchedOn,
                // Carried through, or a searched-for product reads back as a
                // bare can count while a frequent one reads back in litres.
                millilitresPerCan: x.millilitresPerCan ?? null,
                cansPerBox: x.cansPerBox ?? 1,
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
  }, [productQuery, target, searchEnabled, searchMinChars]);

  /**
   * The bill a payment script is about.
   *
   * Fetched when the panel opens rather than carried on every queue row: sixty
   * customers are listed and one is called, so this is one query at the moment
   * somebody actually needs it. `openBillsFor` behind the endpoint resolves
   * each due date through the term chain and enforces scope, so this screen
   * does not get its own second opinion about either.
   */
  /* The clock, read ONCE on mount. Reading it during render is impure and the
   * React Compiler rules reject it; a lazy initialiser runs once and is stable
   * for the life of the panel, which is a single call. */
  const [todayIso] = React.useState(today);

  const [scriptBill, setScriptBill] = React.useState<{
    billNo: string;
    dueDate: string | null;
    balance: number;
  } | null>(null);

  React.useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    fetch(`/api/payments/open-bills?customerId=${target.customerId}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : { bills: [] }))
      .then((d: { bills?: Array<{ billNo: string; dueDate: string | null; balance: number }> }) => {
        const open = d.bills ?? [];
        /*
         * The OLDEST overdue one, which is the bill this call is about — a
         * collections call opens on the debt that has been waiting longest,
         * and quoting the newest invites "that one is not due yet". Where
         * nothing is overdue the oldest open bill still beats a placeholder.
         */
        const overdue = open.filter((b) => b.dueDate && b.dueDate < todayIso);
        setScriptBill((overdue.length ? overdue : open)[0] ?? null);
      })
      /* A script that keeps its braces is the failure this already handles. */
      .catch(() => {});
    return () => controller.abort();
  }, [target, todayIso]);

  /**
   * What a script's placeholders resolve to for this call. Only what the CRM
   * actually knows — anything absent stays in braces rather than becoming an
   * empty gap in a sentence somebody is about to read aloud.
   */
  const scriptFill: Record<string, string> = {};
  if (target?.contactPerson) scriptFill["contact name"] = target.contactPerson;
  if (target?.name) {
    scriptFill["customer"] = target.name;
    scriptFill["customer name"] = target.name;
  }
  if (target?.city) scriptFill["city"] = target.city;
  if (userName) {
    scriptFill["your name"] = userName;
    scriptFill["my name"] = userName;
  }
  if (target?.outstanding) {
    scriptFill["outstanding"] = money(target.outstanding);
    scriptFill["outstanding amount"] = money(target.outstanding);
  }
  if (target?.lastOrderDate) scriptFill["last order date"] = shortDate(target.lastOrderDate);
  if (target?.lastOrderValue) scriptFill["last order value"] = money(target.lastOrderValue);
  if (scriptBill) {
    scriptFill["bill number"] = scriptBill.billNo;
    scriptFill["bill no"] = scriptBill.billNo;
    scriptFill["invoice number"] = scriptBill.billNo;
    scriptFill["amount"] = money(scriptBill.balance);
    scriptFill["bill amount"] = money(scriptBill.balance);
    if (scriptBill.dueDate) {
      scriptFill["due date"] = shortDate(scriptBill.dueDate);
      const late = daysBetween(scriptBill.dueDate, todayIso);
      if (late > 0) scriptFill["days overdue"] = String(late);
    }
  }

  const isOrderReceived = type === "order_received";
  const chosen = isOrderReceived || Boolean(outcome);

  const needsProducts = isOrderReceived || outcome === "order_taken";
  const needsFollowUp = outcome === "follow_up";
  const needsNextCall = outcome === "no_order";
  const needsPayDate =
    type === "inbound_call" && outcome === "payment_promised";
  const showPayDate = outcome === "payment_promised";
  const needsCategory = outcome === "complaint";

  /** The bill a requested credit note is against, for the read-only date. */

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
        subtitle: f.subtitle,
        millilitresPerCan: f.millilitresPerCan,
        cansPerBox: f.cansPerBox,
      }))
    : products.filter((p) => frequentProductIds.includes(p.id));
  const productLabel = (p: ProductOption) =>
    p.packSize ? `${p.name} - ${p.packSize}` : p.name;

  /**
   * Every product this panel has laid eyes on: the starter list, what this
   * customer usually buys, and everything any search has returned.
   *
   * The catalogue is NOT held in the browser — it runs to two hundred SKUs and
   * arrives a search at a time. But a product put on the order has to keep its
   * name afterwards, even once the search that found it has been typed over,
   * so anything seen is remembered for as long as the panel is open.
   */
  const known = React.useMemo(() => {
    const map = new Map<string, ProductOption>();
    for (const p of products) map.set(p.id, p);
    // Read from `info` rather than from `frequent`, which is derived from it —
    // one source per dependency, so the memo says what it actually depends on.
    for (const f of info?.frequentProducts ?? []) {
      map.set(f.productId, {
        id: f.productId,
        name: f.name,
        packSize: f.packSize,
        subtitle: f.subtitle,
        millilitresPerCan: f.millilitresPerCan,
        cansPerBox: f.cansPerBox,
      });
    }
    for (const p of remote?.items ?? []) map.set(p.id, p);
    return map;
  }, [products, info, remote]);

  // What the list shows. Nothing typed: the starter list, which is the book's
  // best sellers. Typed: whatever the server found, because it matches the
  // formulation and the brand and this browser cannot — the same liquid sells
  // as Nano, Astar Nano and M5x4 Thinner.
  const matches = React.useMemo(() => {
    const typed = productQuery.trim();
    if (!typed) return products;
    if (remote && remote.q === typed) return remote.items;

    // Until the server answers, filter what is already here — including the
    // formulation, so a telecaller typing "M5x4" is not told there is no such
    // thing by a list that simply has not looked yet.
    const q = typed.toLowerCase();
    return [...known.values()].filter((p) =>
      `${p.name} ${p.packSize ?? ""} ${p.subtitle ?? ""}`.toLowerCase().includes(q),
    );
  }, [products, productQuery, remote, known]);

  // Typed something, but not yet enough to ask the catalogue. A fourth thing
  // an empty list can mean, and it must not borrow either of the other two
  // sentences: "Looking…" would be a lie, and "no product matches that" would
  // tell a telecaller mid-call that we do not stock something on the strength
  // of one letter.
  const belowMinChars =
    searchEnabled &&
    productQuery.trim() !== "" &&
    productQuery.trim().length < searchMinChars;

  // A search that is still in flight, so an empty list can say "looking"
  // rather than "there is no such product".
  const searching =
    searchEnabled &&
    productQuery.trim() !== "" &&
    !belowMinChars &&
    remote?.q !== productQuery.trim();

  // Long lists are capped until asked for — the design shows a handful and
  // keeps the rest one click away.
  const PRODUCT_PREVIEW = 8;
  const visibleProducts =
    showAllProducts || matches.length <= PRODUCT_PREVIEW
      ? matches
      : matches.slice(0, PRODUCT_PREVIEW);
  const hasMoreProducts = visibleProducts.length < matches.length;

  // The frequent cards are wide, so a customer with a long history would push
  // the search box off the screen. Four is two rows at the usual width.
  const FREQUENT_PREVIEW = 4;
  const visibleFrequent = showAllFrequent ? frequent : frequent.slice(0, FREQUENT_PREVIEW);


  // What has actually been put on the order, read back so nothing is added by
  // accident and left unnoticed. Read from everything the panel has seen, not
  // from the starter list — most orders are for something searched for.
  /**
   * On the order, which is NOT the same question as how many.
   *
   * A line is on the order because somebody put it there; its quantity is a
   * separate fact that can be mid-edit, blank, or wrong. Conflating the two
   * made a box holding "0" look like a chosen product, and made a line vanish
   * out from under the cursor the moment its quantity was cleared to retype.
   */
  const onThisOrder = Object.entries(quantities)
    .map(([id, raw]) => ({ product: known.get(id), qty: Number(raw), raw }))
    .filter((l): l is { product: ProductOption; qty: number; raw: string } =>
      Boolean(l.product),
    );

  /** Blank and zero are not quantities, so neither is a line that will save. */
  const counts = (l: { qty: number; raw: string }) =>
    l.raw.trim() !== "" && Number.isFinite(l.qty) && l.qty > 0;

  /** The lines that will actually be saved. */
  const countedLines = onThisOrder.filter(counts);

  /** Put there, but with nothing said about how many — saving must not guess. */
  const unquantified = onThisOrder.filter((l) => !counts(l));

  /** Removes a line outright, as opposed to setting it to nothing. */
  const removeLine = (id: string) =>
    setQuantities((q) => {
      const next = { ...q };
      delete next[id];
      return next;
    });

  /**
   * Every quantity box goes through here, because zero is not a quantity — it
   * is a removal typed as a number, and the two need telling apart.
   *
   * Zeroing a line that had a count is a deletion, so it asks. Zeroing one that
   * never had a count is nobody's mistake — there is nothing to lose and a
   * dialog about it would be noise, so it just comes off. Until the question is
   * answered the box keeps its old number: a line must never sit at zero
   * looking like an order for none of something.
   */
  function setQuantity(product: ProductOption, raw: string) {
    const typed = raw.trim();
    const n = Number(typed);
    const isZero = typed !== "" && Number.isFinite(n) && n === 0;

    if (isZero) {
      if (Number(quantities[product.id]) > 0) {
        setRemoving(product);
        return;
      }
      removeLine(product.id);
      return;
    }
    setQuantities((q) => ({ ...q, [product.id]: raw }));
  }

  /**
   * What is on the order, in one line: how many products, how many cans, and
   * how many litres that comes to. Litres are what the lorry and the customer
   * both think in, and they are only derivable where every line knows its own
   * pack size — so a mixed order that cannot be totalled says nothing rather
   * than a number that is quietly short.
   */
  const orderSummary = ((): string => {
    if (!countedLines.length) return "Nothing added yet";
    const cans = countedLines.reduce((sum, l) => sum + l.qty, 0);
    const parts = [
      `${countedLines.length} ${countedLines.length === 1 ? "product" : "products"}`,
      `${cans} ${cans === 1 ? "can" : "cans"}`,
    ];
    const measurable = countedLines.every((l) => l.product.millilitresPerCan != null);
    if (measurable) {
      const ml = countedLines.reduce(
        (sum, l) => sum + l.qty * (l.product.millilitresPerCan ?? 0),
        0,
      );
      const litres = ml / 1000;
      parts.push(`${Number.isInteger(litres) ? litres : Number(litres.toFixed(2))} L`);
    }
    return parts.join(" · ");
  })();

  function applyChip(n: QuickNoteOption) {
    const alreadyPicked = picked.includes(n.id);

    if (singleSelect) {
      // §3.3 — one reason, not a pile of them. A second pick REPLACES the
      // first in the stored identifier and in the text, so the note cannot
      // end up reading "Stock sufficient Price issue" and meaning neither.
      //
      // Tapping the chosen one again clears it. A mis-tap has to be undoable
      // without retyping the note, and no quick note at all is a valid save.
      if (alreadyPicked) {
        setPicked([]);
        setNotes((t) => dropLabel(t, n.label));
        return;
      }
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

    // Chips accumulate, and each one toggles. Clicking a chosen chip takes it
    // back off and removes the label it added — previously it silently
    // appended the same words a second time, so a double tap left the note
    // reading "Repeat order Repeat order".
    if (alreadyPicked) {
      setPicked((p) => p.filter((id) => id !== n.id));
      setNotes((t) => dropLabel(t, n.label));
      return;
    }
    setPicked((p) => [...p, n.id]);
    setNotes((t) => addLabel(t, n.label));
  }

  async function save(advance: boolean) {
    if (!target) return;

    // A line somebody put on the order and never counted is a question, not a
    // blank. Dropping it silently is how an order goes out one product short
    // and nobody finds out until the customer rings about it.
    if (needsProducts && unquantified.length) {
      setErrors((e) => ({
        ...e,
        productQuantities:
          unquantified.length === 1
            ? `How many cans of ${unquantified[0].product.name}? Give a quantity, or take it off the order.`
            : `${unquantified.length} products have no quantity. Give each one a number, or take it off the order.`,
      }));
      return;
    }

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
          noOrderNextCallDate:
            needsNextCall && !noOrderNoCommitment && noOrderNextCallDate
              ? noOrderNextCallDate
              : undefined,
          noOrderNoCommitment: needsNextCall ? noOrderNoCommitment : false,
          paymentPromiseDate: showPayDate ? payDate || undefined : undefined,
          complaintCategory: needsCategory ? category : undefined,
          complaintDescription: needsCategory
            ? complaintDescription
            : undefined,
          complaintRequestCn: needsCategory ? requestCn : false,
          complaintImages: needsCategory ? complaintImages : undefined,
          orderDate: isOrderReceived ? orderDate : undefined,
          sourceModule: target.sourceModule ?? "ad_hoc",
          queuePosition: target.queuePosition,
          idempotencyKey: idempotencyKey.current,
        }),
      );

      if (result.ok) {
        setErrors({});
        const label = isOrderReceived
          ? "Order logged"
          : `${OUTCOME_LABEL[outcome!] ?? "Interaction"} logged`;
        setSaved(label);
        /*
         * Handed UP rather than shown here, and the advance goes with it.
         *
         * Moving straight on was what made the next step invisible in the
         * first place: the queue jumped to a new customer and the question
         * "so when do I ring the last one again" had nowhere to be asked.
         * Pressing Enter still answers it in one keystroke.
         */
        onLogged({
          label,
          customerName: target.name,
          step: result.data.nextStep,
          wantsNext: advance,
          canAdvance: Boolean(onSaved),
        });
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
    setRequestCn(false);
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
            all present: an empty "Open complaint - None" column takes space to
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
                {info?.lead ? shortDate(info.lead.addedDate) : "-"}
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
                          This is a lead - nobody here has ordered yet. There is
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
                                  ? "Default - too little history"
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
                                  : "-"}
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
                        {OUTCOME_LABEL[outcome!] ?? "this outcome"} yet - this
                        is the closest script we have.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {script ? (
                  <div className="max-w-[420px]">
                    {scriptBlocks(script, scriptFill).map((b, bi) => (
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
                                title={
                                  part.placeholder && !part.resolved
                                    ? "MahekOne does not know this one — say it in your own words"
                                    : undefined
                                }
                                className={
                                  !part.placeholder
                                    ? undefined
                                    : part.resolved
                                      ? "rounded-[3px] bg-brand-soft px-1 font-medium text-[#5223E0]"
                                      : "rounded-[3px] border border-dashed border-line px-1 font-medium text-muted"
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
                              {scriptBlocks(script, scriptFill)
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
                                              !part.placeholder
                                                ? undefined
                                                : part.resolved
                                                  ? "font-medium text-[#5223E0]"
                                                  : "font-medium text-muted"
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
                          hint="Pick the follow-up date - it becomes a reminder you will see on the day."
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

                      {needsNextCall ? (
                        <Field
                          label="When do we call back"
                          hint="Ask before ringing off. A date they give becomes a reminder and beats the usual wait, so the call lands on the day they named."
                          error={errors.noOrderNextCallDate ?? null}
                        >
                          <div className="mb-1.5 flex flex-wrap gap-1.5">
                            {FOLLOW_UP_PRESETS.map((preset) => {
                              const date = addDays(today(), preset.days);
                              return (
                                <button
                                  key={preset.label}
                                  type="button"
                                  onClick={() => {
                                    setNoOrderNextCallDate(date);
                                    setNoOrderNoCommitment(false);
                                  }}
                                  className={cx(
                                    "h-7 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
                                    !noOrderNoCommitment && noOrderNextCallDate === date
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
                            value={noOrderNoCommitment ? "" : noOrderNextCallDate}
                            min={today()}
                            disabled={noOrderNoCommitment}
                            onChange={(e) => setNoOrderNextCallDate(e.target.value)}
                          />
                          {/*
                            The escape hatch, and it has to be deliberate. Plenty
                            of customers will not name a day, and the telecaller
                            must be able to say so — but by saying it, not by
                            leaving the box empty, which is indistinguishable
                            from having forgotten to ask.
                          */}
                          <label className="mt-2 flex cursor-pointer items-start gap-2 text-[13px] text-body">
                            <input
                              type="checkbox"
                              checked={noOrderNoCommitment}
                              onChange={(e) => {
                                setNoOrderNoCommitment(e.target.checked);
                                if (e.target.checked) setNoOrderNextCallDate("");
                              }}
                              className="mt-0.5 h-4 w-4 cursor-pointer"
                            />
                            <span>
                              They would not commit to a date
                              <span className="block text-[11px] text-muted">
                                We will ask again after the usual wait.
                              </span>
                            </span>
                          </label>
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
                            <VoiceTextarea
                              value={complaintDescription}
                              onChange={(e) => {
                                setComplaintDescription(e.target.value);
                              }}
                              onDictate={setComplaintDescription}
                              className="h-20"
                              placeholder="Describe the complaint in detail."
                            />
                          </Field>

                          <ImagePicker
                            files={complaintImages}
                            onChange={setComplaintImages}
                            max={maxComplaintImages}
                          />

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
                        </>
                      ) : null}

                      {needsProducts ? (
                        <div className="mb-3.5">
                          {/* The label row carries the running total, so what is
                              on the order is legible without reading the list. */}
                          <div className="mb-1.5 flex items-baseline justify-between gap-3">
                            <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                              Products and quantity
                            </span>
                            <span
                              className={cx(
                                "text-[13px]",
                                onThisOrder.length ? "font-medium text-ink" : "text-muted",
                              )}
                            >
                              {orderSummary}
                            </span>
                          </div>

                          {/* What they usually buy, as pickable cards with their
                              own quantity box — the common order is taken here
                              without touching the search at all. */}
                          {frequent.length ? (
                            <div className="mb-2.5 rounded-[4px] border border-line p-3">
                              <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                                Frequently purchased
                              </div>
                              <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
                                {visibleFrequent.map((p) => {
                                  const raw = quantities[p.id];
                                  // Chosen means a real quantity. A box holding
                                  // "0" or left blank is not a product on the
                                  // order, and must not look like one.
                                  const chosen = Number(raw) > 0;
                                  const touched = raw !== undefined;
                                  return (
                                    <div
                                      key={p.id}
                                      className={cx(
                                        "rounded-[4px] border p-2.5",
                                        chosen
                                          ? "border-brand bg-brand-soft"
                                          : "border-line bg-surface",
                                      )}
                                    >
                                      <span className="flex items-start gap-1.5">
                                        <span
                                          className="block min-w-0 flex-1 truncate text-sm font-medium text-ink"
                                          title={p.name}
                                        >
                                          {productLabel(p)}
                                        </span>
                                        {touched ? (
                                          <button
                                            onClick={() => removeLine(p.id)}
                                            title={`Take ${p.name} off this order`}
                                            aria-label={`Take ${p.name} off this order`}
                                            className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded-[4px] border-none bg-transparent text-muted hover:bg-danger-soft hover:text-danger"
                                          >
                                            <Icon name="close" size={12} />
                                          </button>
                                        ) : null}
                                      </span>
                                      <span className="mt-2 flex items-center justify-between gap-2">
                                        <span className="min-w-0 truncate text-xs text-muted">
                                          {p.subtitle ?? ""}
                                        </span>
                                        <input
                                          type="number"
                                          min={0}
                                          inputMode="numeric"
                                          value={raw ?? ""}
                                          onChange={(e) => setQuantity(p, e.target.value)}
                                          placeholder="Qty"
                                          aria-label={`Cans of ${p.name}`}
                                          className="h-8 w-[64px] flex-none rounded-[4px] border border-line bg-surface px-2 text-right text-sm"
                                        />
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                              {frequent.length > FREQUENT_PREVIEW ? (
                                <button
                                  onClick={() => setShowAllFrequent((v) => !v)}
                                  className="mt-2.5 cursor-pointer border-none bg-none p-0 text-[13px] font-medium text-brand"
                                >
                                  {showAllFrequent
                                    ? "Show fewer"
                                    : `Show all ${frequent.length}`}
                                </button>
                              ) : null}
                            </div>
                          ) : info ? (
                            <div className="mb-2 text-[13px] text-muted">
                              No previous orders for this customer.
                            </div>
                          ) : null}

                          {searchEnabled ? (
                            <div className="relative mb-2">
                              <span className="pointer-events-none absolute top-[10px] left-2.5 text-muted">
                                <Icon name="search" size={16} />
                              </span>
                              <input
                                value={productQuery}
                                onChange={(e) => setProductQuery(e.target.value)}
                                placeholder="Search product to add…"
                                aria-label="Search the catalogue"
                                className="h-9 w-full rounded-[4px] border border-line bg-surface pr-8 pl-8 text-sm text-ink outline-none focus:border-brand"
                              />
                              {productQuery ? (
                                <button
                                  onClick={() => setProductQuery("")}
                                  title="Clear the search"
                                  className="absolute top-[7px] right-1.5 h-[22px] w-[22px] cursor-pointer border-none bg-transparent p-0 text-muted hover:text-body"
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Results are a list of things to ADD, not a list with
                              quantity boxes: choosing the product and saying how
                              much of it are two decisions, and merging them is
                              how a stray keystroke becomes an order line. */}
                          {productQuery.trim() ? (
                            <div className="mb-2.5 overflow-hidden rounded-[4px] border border-line shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
                              {visibleProducts.map((p) => {
                                const added = quantities[p.id] !== undefined;
                                return (
                                  <button
                                    key={p.id}
                                    onClick={() =>
                                      setQuantities((q) => ({ ...q, [p.id]: q[p.id] ?? "1" }))
                                    }
                                    disabled={added}
                                    className={cx(
                                      "flex w-full items-center gap-3 border-b border-divider px-2.5 py-2 text-left last:border-0",
                                      added ? "bg-canvas" : "cursor-pointer bg-surface hover:bg-canvas",
                                    )}
                                  >
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm text-ink">
                                        {productLabel(p)}
                                      </span>
                                      {p.subtitle || p.matchedOn ? (
                                        <span className="block truncate text-[11px] text-muted">
                                          {p.subtitle}
                                          {p.subtitle && p.matchedOn ? " · " : ""}
                                          {p.matchedOn ? `matched ${p.matchedOn}` : ""}
                                        </span>
                                      ) : null}
                                    </span>
                                    <span
                                      className={cx(
                                        "flex-none rounded-[4px] border px-2 py-1 text-[13px] font-medium",
                                        added
                                          ? "border-transparent text-muted"
                                          : "border-line text-brand",
                                      )}
                                    >
                                      {added ? "Added" : "Add"}
                                    </span>
                                  </button>
                                );
                              })}
                              {hasMoreProducts ? (
                                <button
                                  onClick={() => setShowAllProducts(true)}
                                  className="w-full cursor-pointer border-t border-canvas bg-canvas px-2.5 py-2 text-left text-[13px] text-muted"
                                >
                                  Show all {matches.length} matches
                                </button>
                              ) : null}
                              {matches.length === 0 ? (
                                <div className="px-2.5 py-5 text-center text-sm text-muted">
                                  {belowMinChars
                                    ? "Keep typing to search the catalogue."
                                    : searching
                                      ? "Looking…"
                                      : "No product matches that. Try the formulation, like “M5x4” or “epoxy”, or the pack size."}
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Everything on the order, editable in place. A line
                              can be re-counted or taken off without hunting for
                              it back in the search results. */}
                          {onThisOrder.length ? (
                            <div className="overflow-hidden rounded-[4px] border border-line">
                              <div className="bg-canvas px-2.5 py-[7px] text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                                Added products
                              </div>
                              {onThisOrder.map((l) => (
                                <div
                                  key={l.product.id}
                                  className="flex items-center gap-3 border-t border-divider bg-surface px-2.5 py-2"
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-ink">
                                      {productLabel(l.product)}
                                    </span>
                                    {l.raw.trim() !== "" && l.qty > 0 ? (
                                      <span className="block truncate text-[11px] text-muted">
                                        {describeQuantity(l.qty, {
                                          millilitresPerCan: l.product.millilitresPerCan ?? null,
                                          cansPerBox: l.product.cansPerBox ?? 1,
                                        })}
                                      </span>
                                    ) : (
                                      <span className="block truncate text-[11px] text-warn-ink">
                                        How many cans?
                                      </span>
                                    )}
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    inputMode="numeric"
                                    value={quantities[l.product.id] ?? ""}
                                    onChange={(e) => setQuantity(l.product, e.target.value)}
                                    placeholder="Qty"
                                    aria-label={`Cans of ${l.product.name}`}
                                    className="h-8 w-[70px] flex-none rounded-[4px] border border-line px-2 text-right text-sm"
                                  />
                                  <button
                                    onClick={() => removeLine(l.product.id)}
                                    title="Remove from this order"
                                    aria-label={`Remove ${l.product.name} from this order`}
                                    className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-[4px] border-none bg-transparent text-muted hover:bg-danger-soft hover:text-danger"
                                  >
                                    <Icon name="close" size={14} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : null}

                          {needsProducts && !countedLines.length ? (
                            <div className="mt-2 rounded-[4px] border border-dashed border-warn-line bg-warn-soft px-3 py-5 text-center text-sm text-warn-ink">
                              At least one product is needed to log this as an
                              order.{" "}
                              {searchEnabled
                                ? "Search above, or tap one this customer usually buys."
                                : "Tap one this customer usually buys."}
                            </div>
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
                            {chips.map((c) => {
                              const on = picked.includes(c.id);
                              return (
                                <button
                                  key={c.id}
                                  onClick={() => applyChip(c)}
                                  // A chip is a toggle, so it reports as one —
                                  // and says what a second tap will do, because
                                  // nothing about a filled pill tells you it
                                  // can be taken back off.
                                  aria-pressed={on}
                                  title={
                                    on
                                      ? `Tap again to remove "${c.label}" from the note`
                                      : undefined
                                  }
                                  className={cx(
                                    "cursor-pointer rounded-full border px-2.5 py-1 text-[13px]",
                                    on
                                      ? "border-brand bg-brand-soft font-medium text-[#5223E0] hover:border-danger hover:text-danger"
                                      : "border-line bg-surface text-body hover:border-brand",
                                  )}
                                >
                                  {c.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      <Field
                        label="Notes"
                        hint="Quick notes add to this - you can still edit or type your own."
                        error={errors.notes ?? null}
                      >
                        <VoiceTextarea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          onDictate={setNotes}
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

      {/* A typed zero on a line that had a count. Keyed on the product so
          reopening it for a different one starts fresh rather than showing the
          last product's name for a frame. */}
      <ConfirmDialog
        key={removing?.id ?? "none"}
        open={Boolean(removing)}
        title="Take this off the order?"
        destructive
        confirmLabel="Take it off"
        cancelLabel="Keep it"
        body={
          removing ? (
            <>
              <span className="block font-medium text-ink">{productLabel(removing)}</span>
              <span className="mt-1 block">
                It is down for{" "}
                {describeQuantity(Number(quantities[removing.id]), {
                  millilitresPerCan: removing.millilitresPerCan ?? null,
                  cansPerBox: removing.cansPerBox ?? 1,
                })}
                . Zero is not a quantity, so this takes the line off the order
                altogether. Nothing else about the call changes, and you can add
                it back from the search.
              </span>
            </>
          ) : null
        }
        onConfirm={() => {
          if (removing) removeLine(removing.id);
        }}
        onClose={() => setRemoving(null)}
      />
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
