"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  PageHeader,
  Progress,
  SectionLabel,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, Tabs } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import {
  actionReply,
  advanceRun,
  archiveTemplate,
  cancelMessage,
  markMessageCopied,
  clearRun,
  confirmMessageSent,
  pauseRun,
  queueMessage,
  saveTemplate,
  sendMessageAutomatic,
  sendRunThroughApi,
  sendWhatsAppNow,
  previewWhatsAppMessage,
  setCustomerGroup,
  startRun,
} from "@/lib/actions/crm";
import { applyMerge, fieldLabel, mergeValues, missingFields, usedFields } from "@/lib/merge";
import { deliveryRoute } from "@/lib/whatsapp-delivery";
import type { MessagePreview } from "@/lib/services/whatsapp-service";
import { toCsv, downloadCsv } from "@/lib/csv";
import { money, phoneDisplay, stamp } from "@/lib/format";
import { CardGrid } from "@/components/ui/card-grid";

/**
 * The real `template_category` enum, with the words a manager reads instead
 * of the column's own snake_case. The dropdown used to offer "Payments",
 * "Orders", "Sales", "Service" — none of them a value Postgres would accept —
 * so saving a new template, or changing an existing one's category, failed
 * outright the moment somebody touched this field.
 */
const TEMPLATE_CATEGORY_OPTIONS = [
  { value: "payment_reminder", label: "Payment reminder" },
  { value: "order_confirmation", label: "Order confirmation" },
  { value: "reactivation", label: "Reactivation" },
  { value: "routine_check_in", label: "Routine check-in" },
  { value: "other", label: "Other" },
] as const;

type Customer = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string;
  city: string;
  outstanding: number;
  lastOrderDate: string | null;
  lastOrderValue: number;
  ownerName: string | null;
  groupName: string | null;
  /** The customer's standing instruction — "both" reaches them twice. */
  destKind: "personal" | "group" | "both";
  oldestBillNo: string | null;
  oldestBillDue: string | null;
  /** Every stated, unpaid bill, oldest first — feeds {{bills_list}}. */
  openBills: Array<{ billNo: string; billDate: string; balance: number }>;
  /** Today, already formatted server-side — feeds {{as_of}}. */
  asOf: string;
  promisedAmount: number | null;
  promisedDate: string | null;
  slowPayer: boolean;
};

type Template = {
  id: string;
  name: string;
  category: string;
  body: string;
  appliesTo: "personal" | "group" | "both";
  uses: number;
  /** The approved Wati template this one is sent as; null = manual only. */
  watiTemplateName: string | null;
  /**
   * The rule set that fills this template (`lib/wati-templates.ts`). When set,
   * the text is rendered on the SERVER — the browser does not hold the bills,
   * the cycle or the last order, and a preview built from less than the send
   * uses would be a preview of a different message.
   */
  spec: string | null;
  archived: boolean;
  updatedAt: string;
};

type Message = {
  id: string;
  customerId: string;
  customerName: string;
  templateName: string | null;
  destination: string;
  destKind: string;
  mode: string;
  status: string;
  sentByName: string;
  edited: boolean;
  createdAt: string;
  /** Separate from confirmedSentAt on purpose — copying is not sending. */
  copiedAt: string | null;
  confirmedSentAt: string | null;
  failureReason: string | null;
};

/** The message lifecycle, in the words a telecaller would use. */
const STATUS_LABEL: Record<string, string> = {
  prepared: "ready",
  copied: "copied - not confirmed",
  sent_manually: "sent",
  sending: "sending",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  cancelled: "skipped",
};

type Reply = {
  id: string;
  customerId: string;
  customerName: string;
  message: string;
  receivedAt: string;
};

type RunRecipient = {
  messageId: string;
  customerName: string;
  status: string;
  done: boolean;
  destKind: "personal" | "group";
};

type Run = {
  id: string;
  templateId: string | null;
  paused: boolean;
  startedAt: string;
  sent: number;
  skipped: number;
  total: number;
  recipients: RunRecipient[];
  current: {
    messageId: string;
    customerId: string;
    customerName: string;
    destination: string;
    destKind: "personal" | "group";
    body: string;
    status: string;
  } | null;
};

type Tab = "send" | "run" | "templates" | "log";

export function WhatsappScreen(props: {
  scopeLabel: string;
  isManager: boolean;
  /** `automatic` = the founder has switched API sending on and a key exists. */
  mode: "manual" | "automatic";
  /** Why nothing can go through the API, when `mode` is manual. */
  apiOffReason: string | null;
  sendingFailing: boolean;
  initialCustomerId: string;
  initialTab: Tab;
  customers: Customer[];
  templates: Template[];
  messages: Message[];
  /** From a `count(*)`. `messages` is capped, so its length is the cap. */
  messageTotal: number;
  messageLimit: number;
  replies: Reply[];
  run: Run | null;
  runElapsedMinutes: number;
  previewTime: string;
  messagesToday: number;
  unconfirmedCount: number;
  followUpCounts: { stage1: number; slow: number; over60: number };
  followUpIds: { stage1: string[]; slow: string[]; over60: string[] };
}) {
  const {
    scopeLabel,
    isManager,
    mode,
    sendingFailing,
    customers,
    templates,
    messages,
    messageTotal,
    messageLimit,
    replies,
    run,
    runElapsedMinutes,
    messagesToday,
    unconfirmedCount,
    followUpCounts,
    followUpIds,
  } = props;

  const router = useRouter();
  const { run: act } = useToast();

  const [tab, setTab] = React.useState<Tab>(props.initialTab);
  const [connOpen, setConnOpen] = React.useState(false);
  const [groupOpen, setGroupOpen] = React.useState(false);
  const [editingTpl, setEditingTpl] = React.useState<Template | null>(null);

  // Copied but never confirmed. Counted from the server's own sweep for
  // managers; telecallers see their own copies still sitting unconfirmed.
  const unconfirmed = messages.filter((m) => m.status === "copied");

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            WhatsApp
            <button
              onClick={() => setConnOpen(true)}
              title="WhatsApp connection settings"
              className="inline-flex h-7 cursor-pointer items-center gap-2 rounded-[4px] border border-line bg-surface px-2.5"
            >
              <span
                className={cx(
                  "block h-2 w-2 rounded-full",
                  mode === "automatic" ? "bg-success" : "bg-warn",
                )}
              />
              <span className="text-[13px] font-medium text-ink">
                {mode === "automatic" ? "WhatsApp API on" : "Manual sending"}
              </span>
              <span className="text-[13px] font-normal text-muted">
                {mode === "automatic" ? "linked templates send directly" : "copy and paste"}
              </span>
            </button>
          </span>
        }
        subtitle={`${scopeLabel} · every message is logged against the customer record, whichever way it is sent.`}
      />

      {/* Automatic sending is on but not working. Said plainly, and paired
          with the reassurance that the manual flow below still works - the
          screen is not blocked, only one route through it is. */}
      {sendingFailing ? (
        <Callout tone="danger">
          <span className="text-sm text-ink">
            Some messages sent through the WhatsApp API in the last day
            failed - the Log tab says why for each one. The manual flow below
            is ready to use, so nothing is blocked.
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => setConnOpen(true)}>
            Check connection
          </Button>
        </Callout>
      ) : null}

      {/* A copy waiting on confirmation, surfaced at screen level — it is easy
          to send the message and walk away from the step that records it. */}
      {unconfirmed.length ? (
        <Callout tone="warn">
          <span className="text-sm font-medium text-warn-ink">
            {unconfirmed.length} awaiting confirmation
          </span>
          <span className="text-[13px] text-body">
            The call log will not hold them back until this is confirmed.
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              const r = await act(confirmMessageSent(unconfirmed[0].id));
              if (r.ok) router.refresh();
            }}
          >
            Confirm sent
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              const r = await act(cancelMessage(unconfirmed[0].id));
              if (r.ok) router.refresh();
            }}
          >
            Discard
          </Button>
        </Callout>
      ) : null}

      <MetricStrip
        metrics={[
          { label: "Sent today", value: String(messagesToday) },
          {
            label: "Copied, never confirmed",
            value: String(isManager ? unconfirmedCount : unconfirmed.length),
            tone: (isManager ? unconfirmedCount : unconfirmed.length) ? "danger" : "ink",
            sub: (isManager ? unconfirmedCount : unconfirmed.length)
              ? "each one may or may not have been sent"
              : undefined,
          },
          { label: "Replies to action", value: String(replies.length), tone: replies.length ? "danger" : "ink" },
          { label: "Templates live", value: String(templates.filter((t) => !t.archived).length) },
          {
            label: "Messages logged",
            value: messageTotal.toLocaleString("en-IN"),
            sub:
              messageTotal > messages.length
                ? `newest ${messages.length} shown in the log`
                : undefined,
          },
        ]}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-4"
        tabs={[
          { key: "send", label: "Send a message" },
          { key: "run", label: "Send run", count: run ? run.recipients.length : undefined },
          { key: "templates", label: "Templates", count: templates.length },
          { key: "log", label: "Log", count: messageTotal },
        ]}
      />

      {tab === "send" ? (
        <SendTab
          {...props}
          onOpenGroup={() => setGroupOpen(true)}
          onSent={() => router.refresh()}
        />
      ) : null}

      {tab === "run" ? (
        <RunTab
          run={run}
          mode={mode}
          elapsedMinutes={runElapsedMinutes}
          previewTime={props.previewTime}
          templates={templates.filter((t) => !t.archived)}
          customers={customers}
          counts={followUpCounts}
          recipientIds={followUpIds}
        />
      ) : null}

      {tab === "templates" ? (
        <Card className="overflow-hidden">
          {templates.length ? (
            <div className="overflow-auto">
              <table>
                <thead>
                  <tr>
                    <Th>Template</Th>
                    <Th>Purpose</Th>
                    <Th>Applies to</Th>
                    <Th>Last edited</Th>
                    <Th align="right">Times used</Th>
                    <Th>WhatsApp API</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => (
                    <Tr
                      key={t.id}
                      onClick={() => setEditingTpl(t)}
                      className="cursor-pointer hover:bg-canvas"
                    >
                      <Td className="font-medium text-ink">{t.name}</Td>
                      <Td>{t.category}</Td>
                      <Td>
                        {t.appliesTo === "group"
                          ? "Customer group"
                          : t.appliesTo === "both"
                            ? "Either destination"
                            : "Personal number"}
                      </Td>
                      <Td>{stamp(t.updatedAt)}</Td>
                      <Td align="right">{t.uses}</Td>
                      <Td
                        title={
                          t.watiTemplateName
                            ? "Sent as this approved Wati template when API sending is on"
                            : "Not linked — only the founder links templates, on the Founder Dashboard"
                        }
                      >
                        {t.watiTemplateName ? (
                          <span className="font-mono text-[12px] text-ink">{t.watiTemplateName}</span>
                        ) : (
                          <span className="text-muted">Manual only</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={t.archived ? "muted" : "success"}>
                          {t.archived ? "Archived" : "Live"}
                        </Badge>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No templates yet"
              body="A manager writes the message wording once, and every telecaller sends the same thing. Order confirmation and the three payment reminder stages are the ones to start with."
            />
          )}
        </Card>
      ) : null}

      {tab === "log" ? (
        <LogTab
          messages={messages}
          total={messageTotal}
          limit={messageLimit}
          isManager={isManager}
        />
      ) : null}

      <ConnectionModal
        open={connOpen}
        mode={mode}
        apiOffReason={props.apiOffReason}
        onClose={() => setConnOpen(false)}
      />

      <GroupModal
        open={groupOpen}
        customers={customers}
        initialId={props.initialCustomerId}
        onClose={() => setGroupOpen(false)}
        onSave={async (customerId, name, dest) => {
          const result = await act(setCustomerGroup(customerId, name, dest));
          if (result.ok) {
            setGroupOpen(false);
            router.refresh();
          }
        }}
      />

      <TemplateDrawer
        template={editingTpl}
        isManager={isManager}
        onClose={() => setEditingTpl(null)}
        onSave={async (values) => {
          const result = await act(saveTemplate(values));
          if (result.ok) {
            setEditingTpl(null);
            router.refresh();
          }
        }}
        onArchive={async (id, archived) => {
          const result = await act(archiveTemplate(id, archived));
          if (result.ok) {
            setEditingTpl(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/* --------------------------------------------------------------- send tab */

type SendTabProps = {
  customers: Customer[];
  templates: Template[];
  replies: Reply[];
  mode: "manual" | "automatic";
  initialCustomerId: string;
  previewTime: string;
  onOpenGroup: () => void;
  onSent: () => void;
};

function SendTab(props: SendTabProps) {
  const [customerId, setCustomerId] = React.useState(props.initialCustomerId);
  const [templateId, setTemplateId] = React.useState(props.templates[0]?.id ?? "");

  // The composer remounts per customer+template pair, so the body is always
  // freshly merged and a half-typed edit never follows you to another customer.
  return (
    <SendComposer
      key={`${customerId}:${templateId}`}
      {...props}
      customerId={customerId}
      templateId={templateId}
      onPickCustomer={setCustomerId}
      onPickTemplate={setTemplateId}
    />
  );
}

function SendComposer({
  customers,
  templates,
  replies,
  mode,
  previewTime,
  onOpenGroup,
  onSent,
  customerId,
  templateId,
  onPickCustomer,
  onPickTemplate,
}: SendTabProps & {
  customerId: string;
  templateId: string;
  onPickCustomer: (id: string) => void;
  onPickTemplate: (id: string) => void;
}) {
  const router = useRouter();
  const { run: act } = useToast();

  const customer = customers.find((c) => c.id === customerId) ?? customers[0];
  const template = templates.find((t) => t.id === templateId);

  const values = customer
    ? mergeValues({
        name: customer.name,
        contactPerson: customer.contactPerson,
        city: customer.city,
        phone: customer.phone,
        outstanding: customer.outstanding,
        lastOrderDate: customer.lastOrderDate,
        lastOrderValue: customer.lastOrderValue,
        oldestBillNo: customer.oldestBillNo,
        oldestBillDue: customer.oldestBillDue,
        openBills: customer.openBills,
        asOf: customer.asOf,
        promisedAmount: customer.promisedAmount,
        promisedDate: customer.promisedDate,
        ownerName: customer.ownerName,
      })
    : ({} as Record<string, string>);

  const [dest, setDest] = React.useState<"personal" | "group" | "both">(
    customer?.groupName ? customer.destKind : "personal",
  );
  const [body, setBody] = React.useState(
    template && !template.spec ? applyMerge(template.body, values) : "",
  );
  const [edited, setEdited] = React.useState(false);
  // For a rule-set template: the server's rendering, or its reasons. Null
  // while it is being asked for.
  const [specPreview, setSpecPreview] = React.useState<MessagePreview | null>(null);
  const specLeg: "personal" | "group" = dest === "personal" ? "personal" : "group";
  React.useEffect(() => {
    if (!template?.spec || !customer) return;
    let live = true;
    previewWhatsAppMessage({ customerId: customer.id, templateId: template.id, destKind: specLeg }).then((r) => {
      if (!live) return;
      const preview: MessagePreview = r.ok ? r.data : { ok: false, reasons: [r.error] };
      setSpecPreview(preview);
      setBody(preview.ok ? preview.body : "");
      setEdited(false);
    });
    return () => {
      live = false;
    };
  }, [template?.spec, template?.id, customer, specLeg]);
  // One entry per leg. A both-ways customer is two independent pieces of work:
  // the group can be pasted and confirmed while the personal message is still
  // sitting copied, and neither may borrow the other's confirmation.
  const [legState, setLegState] = React.useState<
    Record<string, { id: string | null; copied: boolean }>
  >({});
  const legOf = (leg: string) => legState[leg] ?? { id: null, copied: false };
  const [copyFallback, setCopyFallback] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const specBlocked = Boolean(template?.spec) && !(specPreview && specPreview.ok);
  const missing = template?.spec
    ? specPreview && !specPreview.ok
      ? specPreview.reasons
      : []
    : template
      ? missingFields(template.body, values)
      : [];
  const used = template && !template.spec ? usedFields(template.body) : [];

  // The same rule the server sends by (`lib/whatsapp-delivery.ts`). `mode`
  // already folds the founder's switch and the key together; the rest is about
  // this message — a group or both-ways send, an edit, an unlinked template.
  const apiRoute = deliveryRoute({
    serviceOn: mode === "automatic",
    hasToken: mode === "automatic",
    destKind: dest === "personal" ? "personal" : "group",
    watiTemplateName: template?.watiTemplateName,
    edited,
  });

  const activeLegs: Array<"personal" | "group"> =
    dest === "both" ? ["personal", "group"] : [dest];

  const nameOfLeg = (leg: "personal" | "group") =>
    leg === "group"
      ? (customer?.groupName ?? "No group recorded")
      : phoneDisplay(customer?.phone ?? "");

  const destinationName =
    dest === "both"
      ? `${nameOfLeg("personal")} and ${nameOfLeg("group")}`
      : nameOfLeg(dest);

  const grouped = React.useMemo(() => {
    const map = new Map<string, Template[]>();
    for (const t of templates) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return [...map.entries()];
  }, [templates]);

  async function copy(leg: "personal" | "group") {
    if (specBlocked) return;
    try {
      await navigator.clipboard.writeText(body);
      setLegState((s) => ({ ...s, [leg]: { ...legOf(leg), copied: true } }));
      setCopyFallback(null);

      // Log it as Copied so an unconfirmed message is visible, not invisible.
      if (!legOf(leg).id && customer) {
        const result = await act(
          queueMessage({
            customerId: customer.id,
            templateId: template?.id ?? null,
            body,
            edited,
            destKind: leg,
          }),
        );
        if (result.ok && result.data) {
          const id = result.data.id;
          setLegState((s) => ({ ...s, [leg]: { id, copied: true } }));
        }
        onSent();
      }
    } catch {
      setCopyFallback(body);
    }
  }

  if (!customer) {
    return (
      <Card>
        <EmptyState
          title="No customers in view"
          body="Add a customer, or switch the header toggle to the team's book."
        />
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,58fr)_minmax(340px,42fr)] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-4">
        <Card className="p-5">
          <Field label="Customer">
            <Select value={customerId} onChange={(e) => onPickCustomer(e.target.value)}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} - {c.city}
                  {c.outstanding > 0 ? ` · ${money(c.outstanding)} due` : ""}
                </option>
              ))}
            </Select>
          </Field>

          <div className="mt-4 mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Where this goes
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["personal", "group", "both"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDest(d)}
                disabled={d !== "personal" && !customer.groupName}
                className={cx(
                  "rounded-[4px] border px-3 py-2 text-left",
                  d === "both" ? "col-span-2" : "",
                  dest === d
                    ? "border-brand bg-brand-soft"
                    : "border-line bg-surface hover:bg-canvas",
                  d !== "personal" && !customer.groupName
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer",
                )}
              >
                <span className="block text-sm text-ink">
                  {d === "personal"
                    ? "Their own number"
                    : d === "group"
                      ? "Their WhatsApp group"
                      : "Send it both ways"}
                </span>
                <span className="block text-xs text-muted">
                  {d === "personal"
                    ? `${phoneDisplay(customer.phone)} · you paste it`
                    : d === "group"
                      ? `${customer.groupName ?? "No group recorded"} · you paste it`
                      : "The same message to both, one at a time"}
                </span>
              </button>
            ))}
          </div>
          {dest === "both" ? (
            <p className="mt-2 text-[13px] text-muted">
              Both carry the same message. The number reaches the owner
              directly; the group is where their staff actually read it.
            </p>
          ) : null}
          <button
            onClick={onOpenGroup}
            className="mt-2 cursor-pointer text-[13px] text-brand"
          >
            {customer.groupName
              ? "Change the group name for this customer"
              : "Record a group name for this customer"}
          </button>

          <div className="mt-4 mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Template
          </div>
          {grouped.map(([category, list]) => (
            <div key={category} className="mb-2.5">
              <div className="mb-1.5 text-[13px] text-muted">{category}</div>
              <div className="flex flex-wrap gap-2">
                {list.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onPickTemplate(t.id)}
                    className={cx(
                      "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
                      templateId === t.id
                        ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                        : "border-line bg-surface text-body hover:bg-canvas",
                    )}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Card>

        <Card>
          <div className="border-b border-divider px-4 py-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Merge fields
          </div>
          {used.length ? (
            used.map((f) => (
              <div
                key={f}
                className="flex items-center justify-between border-b border-divider px-4 py-2 last:border-0"
              >
                <span className="text-[13px] text-muted">{fieldLabel(f)}</span>
                <span
                  className={cx(
                    "text-[13px] font-medium",
                    values[f] ? "text-ink" : "text-danger",
                  )}
                >
                  {values[f] || "missing"}
                </span>
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-[13px] text-muted">
              This template has no merge fields.
            </div>
          )}
          {template?.spec ? (
            !specPreview ? (
              <div className="px-4 py-3 text-[13px] text-muted">Checking this customer&rsquo;s bills and orders…</div>
            ) : specPreview.ok ? (
              <div className="px-4 py-3 text-[13px] text-muted">
                Filled from this customer&rsquo;s own bills and orders, checked just now.
              </div>
            ) : (
              <div className="bg-danger-soft px-4 py-2.5 text-[13px] text-danger">
                <span className="block font-medium">This message cannot go to this customer:</span>
                {specPreview.reasons.map((r) => (
                  <span key={r} className="mt-1 block">{r}</span>
                ))}
              </div>
            )
          ) : missing.length ? (
            <div className="bg-warn-soft px-4 py-2.5 text-[13px] text-warn-ink">
              {missing.length} field{missing.length === 1 ? "" : "s"} could not be filled
              for this customer - the placeholder stays visible so you can fix it before
              sending.
            </div>
          ) : null}
        </Card>

        <Card className="p-5">
          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel>Message · editable before sending</SectionLabel>
            {edited && template ? (
              <button
                onClick={() => {
                  setBody(
                    template.spec
                      ? specPreview && specPreview.ok
                        ? specPreview.body
                        : ""
                      : applyMerge(template.body, values),
                  );
                  setEdited(false);
                }}
                className="cursor-pointer text-[13px] text-brand"
              >
                Reset to template
              </button>
            ) : null}
          </div>
          <VoiceTextarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setEdited(true);
            }}
            /* Dictating over a merged template is editing it, and the log has
             * to say so — the same as typing a character into it would. */
            onDictate={(v) => {
              setBody(v);
              setEdited(true);
            }}
            className="h-40"
          />
          {edited ? (
            <div className="mt-1.5 text-[13px] text-muted">
              Edited - the log will record this as edited from the template.
            </div>
          ) : null}
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <div className="flex items-center justify-between border-b border-divider px-4 py-3">
            <SectionLabel>How it will look</SectionLabel>
            <span className="text-[13px] text-muted">{destinationName}</span>
          </div>
          <div className="flex justify-end bg-canvas p-5">
            <div className="max-w-[320px] rounded-[6px_6px_2px_6px] border border-brand-softer bg-brand-soft px-3 py-2.5">
              {body.split("\n").map((line, i) => (
                <span
                  key={i}
                  className="block min-h-[11px] text-[15px] leading-[22px] whitespace-pre-wrap text-ink"
                >
                  {line}
                </span>
              ))}
              <span className="mt-1.5 flex items-center justify-end gap-1">
                <span className="text-[11px] text-muted">{previewTime}</span>
                <span className="text-[11px] text-line-strong">✓✓</span>
              </span>
            </div>
          </div>
        </Card>

        {apiRoute.via === "api" && template ? (
          <Card className="p-5">
            <Button
              variant="primary"
              disabled={busy || missing.length > 0 || specBlocked}
              title={
                specBlocked
                  ? "This message cannot go to this customer — the reasons are listed above"
                  : missing.length
                    ? "Fill the missing fields on the customer record first"
                    : undefined
              }
              className="w-full"
              onClick={async () => {
                setBusy(true);
                // `finally`: `act` re-throws what the action threw.
                try {
                  const result = await act(
                    sendWhatsAppNow({ customerId: customer.id, templateId: template.id }),
                  );
                  if (result.ok) {
                    onSent();
                    router.refresh();
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Sending…" : "Send on WhatsApp"}
            </Button>
            <p className="mt-2.5 text-[13px] text-muted">
              Goes from the business number to {nameOfLeg("personal")} as the approved
              template &ldquo;{template.watiTemplateName}&rdquo;. Delivered and read ticks
              come back on their own.
            </p>
          </Card>
        ) : (
          <>
          {mode === "automatic" && apiRoute.via === "manual" ? (
            <p className="-mb-2 text-[13px] text-muted">{apiRoute.why}</p>
          ) : null}
          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
              {dest === "both" ? "Send it both ways" : "Send it in three steps"}
            </div>

            {activeLegs.map((leg, legIndex) => {
              const state = legOf(leg);
              const isCopied = state.copied;
              return (
                <div key={leg}>
                  {dest === "both" ? (
                    <div className="flex items-baseline gap-2 border-b border-divider bg-canvas px-4 py-2">
                      <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white">
                        {legIndex + 1}
                      </span>
                      <span className="text-sm font-medium text-ink">
                        {leg === "personal" ? "To their number" : "To their group"}
                      </span>
                      <span className="text-[13px] text-muted">
                        {nameOfLeg(leg)}
                      </span>
                    </div>
                  ) : null}

                  <Step n={1} title="Copy the message">
                    <Button
                      variant={isCopied ? "secondary" : "primary"}
                      className="w-full"
                      disabled={specBlocked}
                      onClick={() => copy(leg)}
                    >
                      {isCopied ? "Copied ✓" : "Copy the message"}
                    </Button>
                  </Step>

                  <Step n={2} title="Send it from WhatsApp" dimmed={!isCopied}>
                    <Button
                      variant="secondary"
                      className="w-full"
                      disabled={!isCopied}
                      onClick={() =>
                        window.open(
                          leg === "personal"
                            ? `https://wa.me/91${customer.phone.replace(/\D/g, "").slice(-10)}`
                            : "https://web.whatsapp.com",
                          "_blank",
                          "noopener",
                        )
                      }
                    >
                      Open WhatsApp Web ↗
                    </Button>
                    <p className="mt-1.5 text-[13px] text-muted">
                      Paste into:{" "}
                      <span className="font-medium text-ink">{nameOfLeg(leg)}</span>{" "}
                      ({leg === "personal" ? "personal number" : "customer group"})
                    </p>
                  </Step>

                  <Step
                    n={3}
                    title={
                      leg === "group" && dest === "both"
                        ? "Confirm posted to the group"
                        : "Confirm"
                    }
                    dimmed={!isCopied}
                  >
                    <Button
                      variant="primary"
                      className="w-full"
                      disabled={!isCopied || !state.id}
                      onClick={async () => {
                        if (!state.id) return;
                        const result = await act(confirmMessageSent(state.id));
                        if (result.ok) {
                          setLegState((s) => ({
                            ...s,
                            [leg]: { id: null, copied: false },
                          }));
                          onSent();
                          router.refresh();
                        }
                      }}
                    >
                      Mark as sent
                    </Button>
                    <span className="mt-1.5 flex items-center gap-1.5">
                      <span className="text-[13px] text-muted">
                        {leg === "group" && dest === "both"
                          ? "Did not post it?"
                          : "Not sent?"}
                      </span>
                      <button
                        disabled={!state.id}
                        onClick={async () => {
                          if (!state.id) return;
                          await act(cancelMessage(state.id));
                          setLegState((s) => ({
                            ...s,
                            [leg]: { id: null, copied: false },
                          }));
                          router.refresh();
                        }}
                        className="cursor-pointer text-[13px] text-brand disabled:cursor-not-allowed disabled:text-line-strong"
                      >
                        Cancel
                      </button>
                    </span>
                  </Step>
                </div>
              );
            })}

            <div className="bg-canvas px-4 py-2.5 text-[13px] text-muted">
              Confirming is what holds this customer back in the call log, so nobody
              rings them straight after your message.
            </div>
          </Card>
          </>
        )}

        {copyFallback ? (
          <Card className="border-danger-soft border-l-[3px] border-l-danger p-4">
            <div className="text-sm font-medium text-danger">
              The browser blocked the clipboard
            </div>
            <p className="mt-1 text-[13px] text-body">
              Select the text below and copy it with Ctrl + C, then carry on with step 2.
            </p>
            <Textarea readOnly value={copyFallback} className="mt-2.5 h-28" />
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => setCopyFallback(null)}
            >
              Dismiss
            </Button>
          </Card>
        ) : null}

        <Card className="overflow-hidden">
          <div className="border-b border-line px-3.5 py-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Replies needing action
          </div>
          {replies.length ? (
            replies.map((r) => (
              <div
                key={r.id}
                className="border-b border-divider border-l-[3px] border-l-warn px-3.5 py-3 last:border-b-0"
              >
                <div className="text-sm font-medium text-ink">{r.customerName}</div>
                <div className="mt-0.5 text-sm text-body">{r.message}</div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-muted">{stamp(r.receivedAt)}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await act(actionReply(r.id));
                      router.refresh();
                    }}
                  >
                    Action
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <div className="px-3.5 py-6 text-center text-[15px] text-muted">
              Every reply has been actioned.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  dimmed,
  children,
}: {
  n: number;
  title: string;
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 border-b border-divider px-4 py-3.5">
      <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-divider text-[11px] font-medium text-body">
        {n}
      </span>
      <span className={cx("min-w-0 flex-1", dimmed && "opacity-50")}>
        <span className="mb-2 block text-sm font-medium text-ink">{title}</span>
        {children}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- run tab */

function RunTab({
  run,
  mode,
  elapsedMinutes,
  templates,
  customers,
  counts,
  recipientIds,
}: {
  run: Run | null;
  mode: "manual" | "automatic";
  elapsedMinutes: number;
  previewTime: string;
  templates: Template[];
  customers: Customer[];
  counts: { stage1: number; slow: number; over60: number };
  /** Resolved server-side from the same worklist the counts came from. */
  recipientIds: { stage1: string[]; slow: string[]; over60: string[] };
}) {
  const router = useRouter();
  const { run: act, push } = useToast();

  const [templateId, setTemplateId] = React.useState(templates[0]?.id ?? "");
  const [filterKey, setFilterKey] = React.useState<"stage1" | "slow" | "over60">("stage1");
  const [copied, setCopied] = React.useState(false);
  const [bulkArmed, setBulkArmed] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);

  // The hint in the header promises these, so they have to work. Ignored while
  // a field has focus, or typing "s" in a note would skip the customer.
  React.useEffect(() => {
    if (!run?.current) return;
    const current = run.current;
    const handler = async (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;

      const key = e.key.toLowerCase();
      if (key === "c") {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(current.body);
          setCopied(true);
          await act(markMessageCopied(current.messageId));
        } catch {
          push("The browser blocked the clipboard.", "error");
        }
      } else if (e.key === "Enter" && copied) {
        e.preventDefault();
        await act(advanceRun(run.id, current.messageId, "sent"));
        setCopied(false);
        router.refresh();
      } else if (key === "s") {
        e.preventDefault();
        await act(advanceRun(run.id, current.messageId, "skipped"));
        setCopied(false);
        router.refresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [run, copied, act, push, router]);

  if (!run) {
    const template = templates.find((t) => t.id === templateId);
    const filters = [
      { key: "stage1" as const, label: "Stage 1 reminder due", count: counts.stage1 },
      { key: "slow" as const, label: "Slow payers with a balance", count: counts.slow },
      { key: "over60" as const, label: "Overdue more than 60 days", count: counts.over60 },
    ];

    const samples = customers.slice(0, 3).map((c) => ({
      customer: c,
      text: template
        ? applyMerge(
            template.body,
            mergeValues({
              name: c.name,
              contactPerson: c.contactPerson,
              city: c.city,
              phone: c.phone,
              outstanding: c.outstanding,
              lastOrderDate: c.lastOrderDate,
              lastOrderValue: c.lastOrderValue,
              oldestBillNo: c.oldestBillNo,
              oldestBillDue: c.oldestBillDue,
              openBills: c.openBills,
              asOf: c.asOf,
              promisedAmount: c.promisedAmount,
              promisedDate: c.promisedDate,
              ownerName: c.ownerName,
            }),
          )
        : "",
    }));

    return (
      <CardGrid min="broad" className="items-start">
        <Card className="p-5">
          <div className="mb-1 text-lg font-semibold text-ink">Set up a send run</div>
          <p className="mb-4 text-[13px] text-muted">
            Stage 1 payment reminders go to many customers at once, so this is the normal
            way that stage gets worked.
          </p>

          <Field label="Template" className="mb-4">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.category} · {t.name}
                </option>
              ))}
            </Select>
          </Field>

          <SectionLabel>Recipients</SectionLabel>
          <div className="mt-1.5 mb-2 flex flex-col gap-2">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilterKey(f.key)}
                className={cx(
                  "flex h-9 cursor-pointer items-center justify-between rounded-[4px] border px-3 text-sm",
                  filterKey === f.key
                    ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                    : "border-line bg-surface text-body hover:bg-canvas",
                )}
              >
                <span>{f.label}</span>
                <span className="text-muted">{f.count}</span>
              </button>
            ))}
          </div>

          <Button
            variant="primary"
            className="mt-2 w-full"
            disabled={!templateId}
            onClick={async () => {
              const result = await act(
                startRun({
                  templateId,
                  customerIds: recipientIds[filterKey],
                  filterKey,
                }),
              );
              if (result.ok) router.refresh();
            }}
          >
            Start the run
          </Button>

        </Card>

        <Card>
          <div className="border-b border-divider px-4 py-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Check the merge - three samples
          </div>
          {samples.map((s) => (
            <div key={s.customer.id} className="border-b border-canvas px-4 py-3.5 last:border-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-ink">{s.customer.name}</span>
                <span className="text-[13px] text-muted">
                  {s.customer.groupName ?? phoneDisplay(s.customer.phone)}
                </span>
              </div>
              <div className="mt-1.5 text-[13px] leading-5 whitespace-pre-wrap text-body">
                {s.text}
              </div>
            </div>
          ))}
        </Card>
      </CardGrid>
    );
  }

  // Every recipient's message record was created up front, so the current
  // recipient and its rendered body come from the server. A refresh resumes
  // exactly here — nobody restarts a forty-customer run.
  const { sent, skipped, total, current } = run;
  const worked = sent + skipped;
  const percent = total ? Math.round((worked / total) * 100) : 0;
  const elapsed = elapsedMinutes;
  // What the API could take off this run's hands right now: its personal legs
  // still waiting, if the run's template is linked to an approved Wati one.
  const runWati = templates.find((t) => t.id === run.templateId)?.watiTemplateName ?? null;
  const waitingPersonal = run.recipients.filter((r) => !r.done && r.destKind === "personal").length;

  return (
    <div>
      <Card className="mb-4 flex items-center gap-5 px-5 py-3.5">
        <span className="text-lg font-semibold text-ink">
          {worked} of {total} worked
        </span>
        <Progress value={percent} className="max-w-[300px] flex-1" />
        <span className="text-[13px] font-medium text-body">{percent}%</span>
        <span className="h-5 w-px bg-divider" />
        <span className="text-[13px] text-muted">
          {sent} sent · {skipped} skipped
        </span>
        <span className="h-5 w-px bg-divider" />
        <span>
          <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Time taken
          </span>
          <span className="text-[13px] font-medium text-ink">{elapsed} min</span>
        </span>
        <span className="font-mono text-[12px] text-muted">
          C copy · Enter mark sent · S skip
        </span>
        <span className="flex-1" />
        {mode === "automatic" && runWati && waitingPersonal > 0 ? (
          // Two presses, not a browser confirm: this sends to real customers
          // from the business number, and a single stray click must not.
          <Button
            size="sm"
            variant={bulkArmed ? "primary" : "secondary"}
            disabled={bulkBusy}
            title={`Sends as the approved Wati template "${runWati}". Groups stay in the run for pasting.`}
            onClick={async () => {
              if (!bulkArmed) {
                setBulkArmed(true);
                return;
              }
              setBulkBusy(true);
              try {
                await act(sendRunThroughApi(run.id));
                router.refresh();
              } finally {
                setBulkBusy(false);
                setBulkArmed(false);
              }
            }}
          >
            {bulkBusy
              ? "Sending…"
              : bulkArmed
                ? `Confirm: send ${waitingPersonal} now`
                : `Send ${waitingPersonal} through WhatsApp`}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await act(pauseRun(run.id, !run.paused));
            router.refresh();
          }}
        >
          {run.paused ? "Resume" : "Pause"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await act(clearRun(run.id));
            router.refresh();
          }}
        >
          End run
        </Button>
      </Card>

      <div className="grid grid-cols-[clamp(220px,20%,300px)_minmax(0,1fr)] items-start gap-4">
        <Card className="overflow-hidden">
          <div className="border-b border-line px-3.5 py-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Recipients
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {run.recipients.map((r) => {
              const isCurrent = r.messageId === current?.messageId;
              return (
                <div
                  key={r.messageId}
                  className={cx(
                    "flex items-center justify-between gap-2 border-b border-divider px-3.5 py-2 last:border-0",
                    isCurrent && "bg-brand-soft",
                  )}
                >
                  <span
                    className={cx(
                      "truncate text-[13px]",
                      isCurrent ? "font-medium text-ink" : "text-body",
                    )}
                  >
                    {r.customerName}
                  </span>
                  <span
                    className={cx(
                      "flex-none text-[11px]",
                      r.status === "cancelled"
                        ? "text-muted"
                        : r.done
                          ? "text-success"
                          : isCurrent
                            ? "text-brand"
                            : "text-line-strong",
                    )}
                  >
                    {isCurrent && !r.done ? "current" : STATUS_LABEL[r.status] ?? r.status}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>

        {current ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_clamp(280px,26%,340px)] items-start gap-4">
            <Card>
              <div className="border-b border-divider px-5 py-3.5">
                <div className="text-lg font-semibold text-ink">
                  {current.customerName}
                </div>
                <div className="mt-0.5 text-[13px] text-muted">
                  Paste into{" "}
                  {current.destKind === "group"
                    ? current.destination
                    : phoneDisplay(current.destination)}{" "}
                  ({current.destKind === "group" ? "customer group" : "personal number"})
                </div>
              </div>
              <div className="flex justify-end rounded-b-[6px] bg-canvas p-5">
                <div className="max-w-[340px] rounded-[6px_6px_2px_6px] border border-brand-softer bg-brand-soft px-3 py-2.5">
                  {current.body.split("\n").map((line, i) => (
                    <span
                      key={i}
                      className="block min-h-[11px] text-[15px] leading-[22px] whitespace-pre-wrap text-ink"
                    >
                      {line}
                    </span>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
                Send it in three steps
              </div>
              <Step n={1} title="Copy the message">
                <Button
                  variant={copied ? "secondary" : "primary"}
                  className="w-full"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(current.body);
                      setCopied(true);
                      // Recorded as copied, not as sent — the system does not
                      // know it reached anybody until you say so.
                      await act(markMessageCopied(current.messageId));
                    } catch {
                      push("The browser blocked the clipboard.", "error");
                    }
                  }}
                >
                  {copied ? "Copied ✓" : "Copy the message"}
                </Button>
              </Step>
              <Step n={2} title="Send it from WhatsApp" dimmed={!copied}>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={!copied}
                  onClick={() =>
                    window.open(
                      current.destKind === "group"
                        ? "https://web.whatsapp.com"
                        : `https://wa.me/91${current.destination.replace(/\D/g, "").slice(-10)}`,
                      "_blank",
                      "noopener",
                    )
                  }
                >
                  Open WhatsApp Web ↗
                </Button>
              </Step>
              <Step n={3} title="Confirm and move on" dimmed={!copied}>
                <Button
                  variant="primary"
                  className="w-full"
                  disabled={!copied}
                  onClick={async () => {
                    await act(advanceRun(run.id, current.messageId, "sent"));
                    setCopied(false);
                    router.refresh();
                  }}
                >
                  Mark as sent and next
                </Button>
                <button
                  onClick={async () => {
                    await act(advanceRun(run.id, current.messageId, "skipped"));
                    setCopied(false);
                    router.refresh();
                  }}
                  className="mt-1.5 cursor-pointer text-[13px] text-brand"
                >
                  Skip this customer
                </button>
              </Step>
            </Card>
          </div>
        ) : (
          <Card>
            <EmptyState
              title="Run finished"
              body={`${sent} sent, ${skipped} skipped, ${elapsed} minutes.`}
              action={
                <Button
                  variant="primary"
                  onClick={async () => {
                    await act(clearRun(run.id));
                    router.refresh();
                  }}
                >
                  Start another run
                </Button>
              }
            />
          </Card>
        )}
      </div>
    </div>
  );
}


/* ---------------------------------------------------------------- log tab */

function LogTab({
  messages,
  total,
  limit,
  isManager,
}: {
  messages: Message[];
  /** Every message in scope, from SQL — not the length of what arrived. */
  total: number;
  limit: number;
  isManager: boolean;
}) {
  const { push, run: act } = useToast();
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [modeFilter, setModeFilter] = React.useState("All modes");
  const [statusFilter, setStatusFilter] = React.useState("All statuses");

  // Copied but never confirmed. Counted from the server's own sweep for
  // managers; telecallers see their own copies still sitting unconfirmed.
  const unconfirmed = messages.filter((m) => m.status === "copied");

  const filtered = messages.filter((m) => {
    const q = query.trim().toLowerCase();
    // "Connected" is the word on the screen for `automatic` in the row; the
    // two never matched, so the filter emptied the list.
    if (modeFilter !== "All modes" && m.mode !== (modeFilter === "Connected" ? "automatic" : "manual")) return false;
    if (statusFilter !== "All statuses" && m.status !== statusFilter) return false;
    if (!q) return true;
    return (
      m.customerName.toLowerCase().includes(q) ||
      (m.templateName ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div>
      {unconfirmed.length ? (
        <Callout tone="warn">
          <span className="text-[22px] font-semibold text-warn-ink">
            {unconfirmed.length}
          </span>
          <span className="text-sm text-ink">
            message{unconfirmed.length === 1 ? " was" : "s were"} copied but never
            confirmed sent. Each one is a customer who may or may not have been contacted.
          </span>
        </Callout>
      ) : null}

      <Card className="flex items-center gap-2.5 rounded-b-none border-b-0 px-4 py-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search customer or template"
          className="h-8 w-[240px]"
        />
        <Select
          value={modeFilter}
          onChange={(e) => setModeFilter(e.target.value)}
          className="h-8"
        >
          {["All modes", "Manual", "Connected"].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8"
        >
          {["All statuses", "Copied", "Sent", "Delivered", "Read", "Cancelled", "Failed"].map(
            (s) => (
              <option key={s}>{s}</option>
            ),
          )}
        </Select>
        {query || modeFilter !== "All modes" || statusFilter !== "All statuses" ? (
          <button
            onClick={() => {
              setQuery("");
              setModeFilter("All modes");
              setStatusFilter("All statuses");
            }}
            className="h-8 cursor-pointer px-2.5 text-sm text-brand"
          >
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!isManager}
          title={isManager ? "Download as CSV" : "Export is a manager action"}
          onClick={() => {
            downloadCsv(
              "mahek-whatsapp-log",
              toCsv(
                ["Timestamp", "Customer", "Destination", "Template", "Sent by", "Mode", "Status", "Edited"],
                filtered.map((m) => [
                  m.createdAt,
                  m.customerName,
                  m.destination,
                  m.templateName ?? "",
                  m.sentByName,
                  m.mode,
                  m.status,
                  m.edited ? "yes" : "no",
                ]),
              ),
              [statusFilter === "All statuses" ? null : statusFilter, query || null],
            );
            push(
              total > messages.length
                ? `Exported ${filtered.length} rows from the newest ${messages.length} of ${total.toLocaleString("en-IN")}`
                : `Exported ${filtered.length} rows`,
            );
          }}
        >
          Export
        </Button>
      </Card>

      <Card className="overflow-hidden rounded-t-none">
        <div className="max-h-[calc(100vh-420px)] overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Timestamp</Th>
                <Th>Customer</Th>
                <Th>Destination</Th>
                <Th>Template</Th>
                <Th>Sent by</Th>
                <Th>Mode</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <Tr key={m.id} className="hover:bg-canvas">
                  <Td className="whitespace-nowrap">{stamp(m.createdAt)}</Td>
                  <Td className="font-medium text-ink">{m.customerName}</Td>
                  <Td>{m.destination}</Td>
                  <Td>
                    {m.templateName ?? "-"}
                    {m.edited ? (
                      <span className="ml-1.5 text-[11px] text-muted">edited</span>
                    ) : null}
                  </Td>
                  <Td>{m.sentByName}</Td>
                  <Td>{m.mode === "automatic" ? "WhatsApp API" : "Manual"}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      {/* The stored status is lower case; this compared it to
                          capitalised words, so a failed message drew green. */}
                      <Badge
                        tone={
                          m.status === "copied" || m.status === "queued"
                            ? "warn"
                            : m.status === "cancelled" || m.status === "failed"
                              ? "danger"
                              : "success"
                        }
                      >
                        {STATUS_LABEL[m.status] ?? m.status}
                      </Badge>
                      {m.status === "read" || m.status === "delivered" ? (
                        <span
                          className={cx(
                            "text-[11px]",
                            m.status === "read" ? "text-brand" : "text-line-strong",
                          )}
                        >
                          ✓✓
                        </span>
                      ) : null}
                    </span>
                    {m.status === "failed" && m.failureReason ? (
                      <span className="mt-1 block max-w-[320px] text-[12px] text-danger">
                        {m.failureReason}
                      </span>
                    ) : null}
                    {m.status === "failed" && m.mode === "automatic" ? (
                      <button
                        className="mt-1 cursor-pointer text-[12px] text-brand"
                        onClick={async () => {
                          await act(sendMessageAutomatic(m.id));
                          router.refresh();
                        }}
                      >
                        Try again
                      </button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length ? (
          <EmptyState
            title="No messages match these filters"
            body="Clear the filters to see the full log."
          />
        ) : null}
        {/*
          * THREE NUMBERS, AND THE SENTENCE HAS TO KEEP THEM APART.
          *
          * What the filters left, what the server sent, and what there is. It
          * said the first and called it the log, so a book of four thousand
          * messages read as three hundred — and the filters are applied here,
          * in the browser, over a slice, which means "no messages match" can
          * mean "none in the newest 300". Saying all three is the only honest
          * version of a client-side filter over a capped read.
          */}
        <div className="bg-canvas px-4 py-2.5 text-[13px] text-muted">
          Showing {filtered.length} of the newest {messages.length} messages
          {total > messages.length
            ? ` · ${total.toLocaleString("en-IN")} in all, and the filters here reach` +
              ` only the newest ${limit}`
            : null}
          {" · "}every one also appears in Call history and on the customer timeline
        </div>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- overlays */

type ConnectionProps = {
  open: boolean;
  mode: "manual" | "automatic";
  apiOffReason: string | null;
  onClose: () => void;
};

/**
 * What the connection IS, and where it is decided. This used to let a manager
 * flip sending to automatic from here — a setting, behind a stub that marked
 * messages sent without sending them. The decision is the founder's now, on the
 * Founder Dashboard, so this says which way it stands and nothing more.
 */
function ConnectionModal({ open, mode, apiOffReason, onClose }: ConnectionProps) {
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="WhatsApp connection"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className={cx("block h-2 w-2 rounded-full", mode === "automatic" ? "bg-success" : "bg-warn")}
        />
        <span className="text-sm font-medium text-ink">
          {mode === "automatic" ? "Sending through the WhatsApp API is on" : "Manual sending"}
        </span>
      </div>
      <p className="mb-3 text-sm text-body">
        {mode === "automatic"
          ? "A template linked to an approved Wati template goes straight from the business number to the customer's own number. Groups, edited messages and unlinked templates are still copied and pasted, exactly as before."
          : (apiOffReason ?? "Every message is copied, pasted into WhatsApp and confirmed.")}
      </p>
      <p className="text-[13px] text-muted">
        Only the founder can switch API sending on or off, and link templates to
        Wati - on the Founder Dashboard, under WhatsApp. Manual sending always
        works, whichever way it is set.
      </p>
    </Modal>
  );
}

type GroupModalProps = {
  open: boolean;
  customers: Customer[];
  initialId: string;
  onClose: () => void;
  onSave: (
    customerId: string,
    name: string,
    dest: "personal" | "group" | "both",
  ) => Promise<void>;
};

function GroupModal(props: GroupModalProps) {
  if (!props.open) return null;
  return <GroupModalBody key={props.initialId} {...props} />;
}

function GroupModalBody({ open, customers, initialId, onClose, onSave }: GroupModalProps) {
  const [customerId, setCustomerId] = React.useState(initialId);
  const [name, setName] = React.useState(
    customers.find((c) => c.id === initialId)?.groupName ?? "",
  );
  const [dest, setDest] = React.useState<"personal" | "group" | "both">(
    customers.find((c) => c.id === initialId)?.destKind ?? "group",
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a customer group"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(customerId, name, dest)}>
            Save group
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Customer">
          <Select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              const picked = customers.find((c) => c.id === e.target.value);
              setName(picked?.groupName ?? "");
              setDest(picked?.destKind ?? "group");
            }}
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Group name as it appears in WhatsApp"
          hint="Leave it blank to send to the personal number instead."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shree Paints order group"
          />
        </Field>
        <Field
          label="Where their messages go"
          hint="Every customer has two points of contact. They can be the same person."
        >
          <Select
            value={dest}
            disabled={!name.trim()}
            onChange={(e) =>
              setDest(e.target.value as "personal" | "group" | "both")
            }
          >
            <option value="group">Their WhatsApp group</option>
            <option value="personal">Their own number</option>
            <option value="both">Both - the same message to each</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

type TemplateDrawerProps = {
  template: Template | null;
  isManager: boolean;
  onClose: () => void;
  onSave: (values: {
    id?: string;
    name: string;
    category: string;
    body: string;
    appliesTo: "personal" | "group" | "both";
  }) => Promise<void>;
  onArchive: (id: string, archived: boolean) => Promise<void>;
};

function TemplateDrawer(props: TemplateDrawerProps) {
  if (!props.template) return null;
  return <TemplateDrawerBody key={props.template.id} {...props} />;
}

function TemplateDrawerBody({
  template,
  isManager,
  onClose,
  onSave,
  onArchive,
}: TemplateDrawerProps) {
  const [name, setName] = React.useState(template?.name ?? "");
  const [category, setCategory] = React.useState(template?.category ?? "payment_reminder");
  const [body, setBody] = React.useState(template?.body ?? "");
  const [appliesTo, setAppliesTo] = React.useState<"personal" | "group" | "both">(
    template?.appliesTo ?? "personal",
  );

  const tooLong = body.length > 700;

  return (
    <Drawer
      open={Boolean(template)}
      onClose={onClose}
      width={560}
      label="Edit template"
    >
      {template ? (
        <>
          <DrawerHeader onClose={onClose}>
            <div className="text-lg font-semibold text-ink">
              Edit template · {template.name}
            </div>
            <div className="mt-1 text-[13px] text-muted">
              Used {template.uses} times · last edited {stamp(template.updatedAt)}
            </div>
          </DrawerHeader>

          <div className="flex-1 overflow-y-auto p-5">
            {!isManager ? (
              <div className="mb-4 rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
                Read only - editing templates is a manager action.
              </div>
            ) : null}

            <div className="grid gap-3">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!isManager}
                />
              </Field>
              <Field label="Purpose">
                <Select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={!isManager}
                >
                  {TEMPLATE_CATEGORY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Applies to">
                <Select
                  value={appliesTo}
                  onChange={(e) =>
                    setAppliesTo(e.target.value as "personal" | "group" | "both")
                  }
                  disabled={!isManager}
                >
                  <option value="personal">Personal number</option>
                  <option value="group">Customer group</option>
                  <option value="both">Either destination</option>
                </Select>
              </Field>
              <Field
                label="Message body"
                hint="Merge fields: {{customer}} {{contact}} {{city}} {{phone}} {{outstanding}} {{bill_no}} {{bill_due}} {{bills_list}} {{as_of}} {{promised_amount}} {{promised_date}} {{last_order_date}} {{last_order_value}} {{owner}}"
                error={tooLong ? "Long messages get skimmed - try to stay under 700 characters." : null}
              >
                <VoiceTextarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onDictate={setBody}
                  disabled={!isManager}
                  className="h-56"
                />
              </Field>
              <div className="text-[13px] text-muted">{body.length} characters</div>
            </div>
          </div>

          <div className="flex gap-2.5 border-t border-line px-5 py-3">
            <Button
              variant="primary"
              disabled={!isManager}
              onClick={() =>
                onSave({ id: template.id, name, category, body, appliesTo })
              }
            >
              Save template
            </Button>
            <Button
              variant="secondary"
              disabled={!isManager}
              onClick={() => onArchive(template.id, !template.archived)}
            >
              {template.archived ? "Restore" : "Archive"}
            </Button>
          </div>
        </>
      ) : null}
    </Drawer>
  );
}
