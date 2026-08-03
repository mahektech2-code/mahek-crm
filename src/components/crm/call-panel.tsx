"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import {
  Badge,
  Button,
  Field,
  Input,
  MoneyInput,
  Select,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { saveCall } from "@/lib/actions/crm";
import { money, phoneDisplay, shortDate, stamp, today } from "@/lib/format";

export type CallTarget = {
  customerId: string;
  /** Where the call was started from — kept on the call record. */
  sourceModule?: "call_queue" | "payment_follow_up" | "inactive_watch" | "ad_hoc";
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
  /** Omitted by callers that let the panel fetch it on open. */
  history?: HistoryEntry[];
};

export type HistoryEntry = {
  kind: string;
  at: string;
  actor: string;
  content: string;
};

const OUTCOMES = [
  "Order placed",
  "Will order later",
  "Payment promised",
  "Not interested",
  "Call back later",
  "Complaint raised",
  "No answer",
] as const;

const CONNECTIONS = [
  "Connected",
  "Missed",
  "Not reachable",
  "Busy",
  "Wrong number",
] as const;

const PRODUCTS = ["NC thinner 20L", "MTO thinner 200L", "Low-odour thinner 20L"];
const COMPLAINT_CATEGORIES = [
  "Delivery",
  "Product quality",
  "Billing",
  "Pricing",
  "Service",
  "Other",
];

type CallPanelProps = {
  target: CallTarget | null;
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

function CallPanelForm({ target, onClose, onSaved, hasNext }: CallPanelProps) {
  const router = useRouter();
  const { run, push } = useToast();

  const [connection, setConnection] =
    React.useState<(typeof CONNECTIONS)[number]>("Connected");
  const [outcome, setOutcome] = React.useState<string>("");
  const [outcomeError, setOutcomeError] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // The panel is keyed on the customer, so this is generated once per opening
  // and rejected by the server on a second submit of the same call.
  const idempotencyKey = React.useRef(crypto.randomUUID());

  const [orderOpen, setOrderOpen] = React.useState(false);
  const [orderProduct, setOrderProduct] = React.useState(PRODUCTS[0]);
  const [orderQty, setOrderQty] = React.useState("1");
  const [orderValue, setOrderValue] = React.useState("");
  const [orderDispatch, setOrderDispatch] = React.useState("");

  const [remOpen, setRemOpen] = React.useState(false);
  const [remDue, setRemDue] = React.useState("");
  const [remNote, setRemNote] = React.useState("");

  const [cmpOpen, setCmpOpen] = React.useState(false);
  const [cmpCat, setCmpCat] = React.useState(COMPLAINT_CATEGORIES[0]);
  const [cmpDesc, setCmpDesc] = React.useState("");

  // The last three interactions load with the panel rather than being
  // prefetched for every row behind it.
  const [history, setHistory] = React.useState<HistoryEntry[] | null>(
    target?.history ?? null,
  );
  React.useEffect(() => {
    if (!target || target.history) return;
    const controller = new AbortController();
    fetch(`/api/customer-history?customerId=${target.customerId}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : { history: [] }))
      .then((d) => setHistory(d.history))
      .catch(() => setHistory([]));
    return () => controller.abort();
  }, [target]);

  const save = React.useCallback(
    async (advance: boolean) => {
      if (!target) return;
      if (!outcome) {
        setOutcomeError(true);
        push("Pick the outcome — it decides what happens to this customer next.", "error");
        return;
      }
      setBusy(true);
      try {
        const result = await run(
          saveCall({
            customerId: target.customerId,
            sourceModule: target.sourceModule ?? "ad_hoc",
            // Stable for as long as the panel is open on this customer, so a
            // double-click or a retried submit logs one call, not two.
            idempotencyKey: idempotencyKey.current,
            connection,
            outcome,
            note,
            orderProduct: orderOpen ? orderProduct : undefined,
            orderQty: orderOpen ? orderQty : undefined,
            orderValue: orderOpen ? orderValue : undefined,
            orderDispatch: orderOpen ? orderDispatch : undefined,
            reminderDue: remOpen ? remDue : undefined,
            reminderNote: remOpen ? remNote : undefined,
            complaintCategory: cmpOpen ? cmpCat : undefined,
            complaintDesc: cmpOpen ? cmpDesc : undefined,
          }),
        );
        if (result.ok) {
          router.refresh();
          onSaved?.(advance);
          if (!advance) onClose();
        }
      } finally {
        setBusy(false);
      }
    },
    [
      target,
      outcome,
      connection,
      note,
      orderOpen,
      orderProduct,
      orderQty,
      orderValue,
      orderDispatch,
      remOpen,
      remDue,
      remNote,
      cmpOpen,
      cmpCat,
      cmpDesc,
      run,
      push,
      router,
      onSaved,
      onClose,
    ],
  );

  React.useEffect(() => {
    if (!target) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void save(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [target, save]);

  if (!target) return null;

  return (
    <Drawer open onClose={onClose} label={`Call ${target.name}`}>
      <DrawerHeader onClose={onClose}>
        <div className="text-lg leading-6 font-semibold text-ink">{target.name}</div>
        <div className="mt-1 flex items-center gap-2 text-[13px] text-muted">
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
        <div className="mt-0.5 text-[13px] text-muted">
          {target.city} · Owner {target.ownerName ?? "unassigned"}
        </div>
        {target.reason ? (
          <div className="mt-2.5">
            <Badge tone="brand">{target.reason}</Badge>
          </div>
        ) : null}
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-5">
        {target.openComplaint ? (
          <div className="mb-3.5 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5">
            <div className="text-[11px] font-medium tracking-[0.04em] text-danger uppercase">
              Open complaint — mention this first
            </div>
            <div className="mt-1 text-sm text-ink">{target.openComplaint}</div>
          </div>
        ) : null}

        <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-[4px] border border-line bg-divider">
          <Fact label="Last order">
            {target.lastOrderDate ? shortDate(target.lastOrderDate) : "None yet"}
            {target.lastOrderValue ? ` · ${money(target.lastOrderValue)}` : ""}
          </Fact>
          <Fact label="Outstanding" tone={target.outstanding > 0 ? "danger" : "ink"}>
            {money(target.outstanding)}
          </Fact>
          <Fact label="Target gap this month">{money(target.targetGap)}</Fact>
          <Fact label="Credit terms">{target.creditTermDays} days</Fact>
        </div>

        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Last three interactions
        </div>
        <div className="mb-5 rounded-[4px] border border-line">
          {history === null ? (
            <div className="px-3 py-4 text-[13px] text-muted">Loading…</div>
          ) : history.length ? (
            history.slice(0, 3).map((h, i) => (
              <div key={i} className="border-b border-canvas px-3 py-2 last:border-0">
                <div className="flex items-center gap-2 text-[11px] text-muted">
                  <span className="font-medium text-body">{h.kind}</span>
                  <span>{stamp(h.at)}</span>
                  <span>·</span>
                  <span>{h.actor}</span>
                </div>
                <div className="mt-0.5 text-[13px] text-body">{h.content}</div>
              </div>
            ))
          ) : (
            <div className="px-3 py-4 text-[13px] text-muted">
              Nothing has been logged against this customer yet.
            </div>
          )}
        </div>

        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Did the call connect
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          {CONNECTIONS.map((c) => (
            <Chip key={c} active={connection === c} onClick={() => setConnection(c)}>
              {c}
            </Chip>
          ))}
        </div>

        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Call outcome · required
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          {OUTCOMES.map((o) => (
            <Chip
              key={o}
              active={outcome === o}
              invalid={outcomeError && !outcome}
              onClick={() => {
                setOutcome(o);
                setOutcomeError(false);
                if (o === "Order placed") setOrderOpen(true);
                if (o === "Call back later" || o === "Payment promised") setRemOpen(true);
                if (o === "Complaint raised") setCmpOpen(true);
              }}
            >
              {o}
            </Chip>
          ))}
        </div>
        {outcomeError ? (
          <div className="-mt-2 mb-3 text-[13px] text-danger">
            Pick the outcome — it decides what happens to this customer next.
          </div>
        ) : null}

        <Field label="Notes">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was said, what happens next"
            className="h-19"
          />
        </Field>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <Expander
            active={orderOpen}
            onClick={() => setOrderOpen((o) => !o)}
            label="Capture order"
          />
          <Expander
            active={remOpen}
            onClick={() => setRemOpen((o) => !o)}
            label="Set reminder"
          />
          <Expander
            active={cmpOpen}
            onClick={() => setCmpOpen((o) => !o)}
            label="Log complaint"
          />
        </div>

        {orderOpen ? (
          <div className="mt-2 rounded-[4px] border border-line bg-canvas p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Product">
                <Select
                  value={orderProduct}
                  onChange={(e) => setOrderProduct(e.target.value)}
                >
                  {PRODUCTS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity (drums)">
                <Input
                  type="number"
                  min={1}
                  value={orderQty}
                  onChange={(e) => setOrderQty(e.target.value)}
                />
              </Field>
              <Field label="Order value · required">
                <MoneyInput
                  value={orderValue}
                  onChange={(e) => setOrderValue(e.target.value)}
                  placeholder="96,000"
                />
              </Field>
              <Field label="Expected dispatch">
                <Input
                  type="date"
                  min={today()}
                  value={orderDispatch}
                  onChange={(e) => setOrderDispatch(e.target.value)}
                />
              </Field>
            </div>
          </div>
        ) : null}

        {remOpen ? (
          <div className="mt-2 rounded-[4px] border border-line bg-canvas p-3">
            <div className="grid grid-cols-[160px_1fr] gap-3">
              <Field label="Due date">
                <Input
                  type="date"
                  value={remDue}
                  onChange={(e) => setRemDue(e.target.value)}
                />
              </Field>
              <Field label="What was promised · required">
                <Input
                  value={remNote}
                  onChange={(e) => setRemNote(e.target.value)}
                  placeholder="Call back about the 200L drum rate"
                />
              </Field>
            </div>
          </div>
        ) : null}

        {cmpOpen ? (
          <div className="mt-2 rounded-[4px] border border-line bg-canvas p-3">
            <div className="grid grid-cols-[180px_1fr] gap-3">
              <Field label="Category">
                <Select value={cmpCat} onChange={(e) => setCmpCat(e.target.value)}>
                  {COMPLAINT_CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Description · required">
                <Input
                  value={cmpDesc}
                  onChange={(e) => setCmpDesc(e.target.value)}
                  placeholder="What the customer reported, in their words"
                />
              </Field>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-2.5 border-t border-line bg-surface px-5 py-3">
        <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
          {busy ? "Saving…" : hasNext ? "Save and next" : "Save"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void save(false)}>
          Save and close
        </Button>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">Ctrl + Enter</span>
      </div>
    </Drawer>
  );
}

function Fact({
  label,
  children,
  tone = "ink",
}: {
  label: string;
  children: React.ReactNode;
  tone?: "ink" | "danger";
}) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </div>
      <div
        className={cx(
          "mt-0.5 text-sm font-medium",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Chip({
  active,
  invalid,
  onClick,
  children,
}: {
  active: boolean;
  invalid?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
        active
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : invalid
            ? "border-danger bg-surface text-body"
            : "border-line bg-surface text-body hover:bg-canvas",
      )}
    >
      {children}
    </button>
  );
}

function Expander({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[4px] border text-[13px]",
        active
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : "border-line bg-surface text-body hover:bg-canvas",
      )}
    >
      <Icon name={active ? "close" : "plus"} size={14} />
      {label}
    </button>
  );
}
