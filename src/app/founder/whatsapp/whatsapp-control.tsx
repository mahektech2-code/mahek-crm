"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Callout,
  MetricStrip,
  PageHeader,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import { linkWatiTemplateAction, setWhatsappServiceAction } from "@/lib/actions/whatsapp-founder";
import {
  SecretCredentialRow,
  type SecretMeta,
  type SecretRow,
} from "@/app/admin/secret-credential-row";

/* ---------------------------------------------------------------------------
 * The founder's WhatsApp desk.
 *
 * THE SWITCH IS THE HEADLINE. Everything else on the page is what the switch
 * depends on — a key, a connection, approved templates linked to the CRM's —
 * laid out as a checklist, so "I switched it on and nothing went" always has
 * its answer on the same screen, one line below the switch.
 * ------------------------------------------------------------------------- */

type WatiTemplateRow = {
  name: string;
  status: string;
  category: string | null;
  language: string | null;
  body: string;
  params: string[];
};

type CrmTemplateRow = {
  id: string;
  name: string;
  category: string;
  escalationStage: number | null;
  body: string;
  watiTemplateName: string | null;
};

type Health =
  | { ok: true; channels: string[]; templates: number; approved: number }
  | { ok: false; error: string };

const KEY_META: SecretMeta = {
  label: "Wati",
  env: "WATI_API_TOKEN",
  what: "Sends approved WhatsApp templates from the business number, and signs the webhook address Wati reports delivery back to. Holding it switches nothing on — the switch above does.",
  where: "Wati dashboard → API Docs → API tokens",
  removalConsequence:
    "Nothing can go through the API until a key is set again; every screen falls back to copy and paste. The webhook address changes with the next key.",
};

const CATEGORY_LABEL: Record<string, string> = {
  order_confirmation: "Order confirmation",
  payment_reminder: "Payment reminder",
  routine_check_in: "Check-in",
  reactivation: "Reactivation",
  other: "Other",
};

export function WhatsappControl(props: {
  state: { active: boolean; at: string | null; byName: string | null; note: string | null };
  history: Array<{ id: string; active: boolean; note: string | null; byName: string; at: string }>;
  keyRow: SecretRow;
  canWriteKey: boolean;
  health: Health;
  watiTemplates: WatiTemplateRow[];
  watiTemplatesError: string | null;
  crmTemplates: CrmTemplateRow[];
  mergeFields: string[];
  counts: Record<string, number>;
  unmatchedReplies: Array<{
    id: string;
    waId: string | null;
    senderName: string | null;
    message: string;
    receivedAt: string;
  }>;
  webhookUrl: string | null;
}) {
  const { state, health } = props;
  const [switching, setSwitching] = React.useState(false);

  const approved = props.watiTemplates.filter((t) => t.status === "APPROVED");
  const linked = props.crmTemplates.filter((t) => t.watiTemplateName);
  const hasKey = props.keyRow.source !== "unset";

  const checks: Array<{ ok: boolean; label: string; detail: string }> = [
    {
      ok: hasKey,
      label: "Wati key",
      detail: hasKey
        ? `Set${props.keyRow.last4 ? ` · ends ${props.keyRow.last4}` : ""} · from the ${props.keyRow.source === "console" ? "console" : "server environment"}`
        : "No key — nothing can be sent until one is set below.",
    },
    {
      ok: health.ok,
      label: "Connection to Wati",
      detail: health.ok
        ? `Working · ${health.channels.join(", ") || "no channel reported"}`
        : health.error,
    },
    {
      ok: approved.length > 0,
      label: "Approved templates in Wati",
      detail: health.ok
        ? `${approved.length} approved of ${props.watiTemplates.length}. WhatsApp only lets a business start a conversation with an approved template.`
        : "Unknown until the connection works.",
    },
    {
      ok: linked.length > 0,
      label: "CRM templates linked",
      detail: `${linked.length} of ${props.crmTemplates.length} linked. An unlinked template is always copied and pasted.`,
    },
  ];
  const ready = checks.every((c) => c.ok);

  const c = props.counts;
  const sent = (c.sent ?? 0) + (c.delivered ?? 0) + (c.read ?? 0);

  return (
    <div className="p-6">
      <PageHeader
        title="WhatsApp"
        subtitle="Whether messages go to customers through the WhatsApp API at all is decided here, and only here. Off, every screen copies and pastes exactly as before."
      />

      {/* ------------------------------------------------------- the switch */}
      <Card className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-5 px-5 py-5">
          <span
            className={cx(
              "block h-3.5 w-3.5 flex-none rounded-full",
              state.active ? "bg-success" : "bg-line-strong",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-xl font-semibold text-ink">
              {state.active ? "Sending through WhatsApp is ON" : "Sending through WhatsApp is OFF"}
            </div>
            <div className="mt-1 text-[13px] text-muted">
              {state.at
                ? `${state.active ? "Switched on" : "Switched off"} by ${state.byName} · ${stamp(state.at)}${state.note ? ` · “${state.note}”` : ""}`
                : "Never switched on. Nothing has gone to a customer through the API."}
            </div>
            {state.active && !ready ? (
              <div className="mt-2 text-[13px] text-warn">
                On, but not everything below is ready — messages that cannot go
                through the API are still copied and pasted.
              </div>
            ) : null}
          </div>
          <Button
            variant={state.active ? "secondary" : "primary"}
            onClick={() => setSwitching(true)}
          >
            {state.active ? "Switch off" : "Switch on"}
          </Button>
        </div>
        <div className="grid grid-cols-1 border-t border-divider md:grid-cols-2">
          {checks.map((ch) => (
            <div key={ch.label} className="flex items-start gap-2.5 border-b border-divider px-5 py-3 md:odd:border-r">
              <span className={cx("mt-0.5 text-sm", ch.ok ? "text-success" : "text-danger")}>
                {ch.ok ? "✓" : "✕"}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{ch.label}</span>
                <span className="block text-[13px] break-words text-muted">{ch.detail}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>

      <MetricStrip
        metrics={[
          { label: "Sent · 7 days", value: String(sent), sub: "accepted by WhatsApp" },
          { label: "Delivered", value: String((c.delivered ?? 0) + (c.read ?? 0)) },
          { label: "Read", value: String(c.read ?? 0) },
          { label: "Failed", value: String(c.failed ?? 0), sub: c.failed ? "reasons on the CRM's WhatsApp log" : undefined },
        ]}
      />

      {/* ------------------------------------------------------ templates */}
      <TemplateLinks
        crmTemplates={props.crmTemplates}
        watiTemplates={props.watiTemplates}
        mergeFields={props.mergeFields}
        error={props.watiTemplatesError}
      />

      {/* ----------------------------------------------------- connection */}
      <Card className="mb-4">
        <CardHeader
          title="Connection"
          hint={
            props.canWriteKey
              ? "The key Wati is called with. A key saved here wins over the server's own."
              : "The key Wati is called with. Changing it is a platform admin's job; this shows whether one is set."
          }
        />
        <div className="divide-y divide-divider">
          <SecretCredentialRow row={props.keyRow} meta={KEY_META} canWrite={props.canWriteKey} />
        </div>
        <div className="border-t border-divider px-5 py-4">
          <div className="text-sm font-medium text-ink">Webhook address</div>
          <p className="mt-1 text-[13px] text-muted">
            Paste this into Wati → Webhooks, and tick: message received, sent
            message delivered, sent message read, and template message failed.
            That is how delivered and read ticks, failures and customers&rsquo;
            replies reach MahekOne. It is a secret — anybody holding it can post
            to it — and it changes whenever the key does.
          </p>
          {props.webhookUrl ? <CopyLine value={props.webhookUrl} /> : (
            <p className="mt-2 text-[13px] text-danger">Set a key first — the address is made from it.</p>
          )}
        </div>
      </Card>

      {/* -------------------------------------------- replies we could not file */}
      {props.unmatchedReplies.length ? (
        <Card className="mb-4 overflow-hidden">
          <CardHeader
            title="Replies from numbers not on the book"
            hint="Kept rather than dropped. Put the number on the right customer and future replies file themselves."
          />
          <table className="w-full">
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>From</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {props.unmatchedReplies.map((r) => (
                <Tr key={r.id}>
                  <Td className="whitespace-nowrap">{stamp(r.receivedAt)}</Td>
                  <Td>
                    {r.senderName ?? "-"}
                    <span className="block font-mono text-[12px] text-muted">+{r.waId}</span>
                  </Td>
                  <Td className="max-w-[480px] whitespace-pre-wrap">{r.message}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {/* -------------------------------------------------------- history */}
      <Card className="overflow-hidden">
        <CardHeader title="Who switched it, and when" hint="Every change is kept. Nothing here is ever edited." />
        {props.history.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Switched</Th>
                <Th>By</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {props.history.map((h) => (
                <Tr key={h.id}>
                  <Td className="whitespace-nowrap">{stamp(h.at)}</Td>
                  <Td>
                    <Badge tone={h.active ? "success" : "muted"}>{h.active ? "On" : "Off"}</Badge>
                  </Td>
                  <Td>{h.byName}</Td>
                  <Td className="text-muted">{h.note ?? "-"}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-5 py-4 text-[13px] text-muted">Never switched. It has been off since the start.</p>
        )}
      </Card>

      <SwitchModal
        key={String(switching)}
        open={switching}
        turningOn={!state.active}
        ready={ready}
        onClose={() => setSwitching(false)}
      />
    </div>
  );
}

/* ------------------------------------------------------------ the switch */

function SwitchModal({
  open,
  turningOn,
  ready,
  onClose,
}: {
  open: boolean;
  turningOn: boolean;
  ready: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={turningOn ? "Switch WhatsApp sending on?" : "Switch WhatsApp sending off?"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await run(setWhatsappServiceAction(turningOn, note));
                if (r.ok) {
                  onClose();
                  router.refresh();
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            {turningOn ? "Switch on" : "Switch off"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-body">
        {turningOn
          ? "From the next message, anything sent with a linked template goes straight from the business number to the customer — payment reminders from the collections screen, and send runs. Groups and edited messages are still copied and pasted."
          : "From the next message, nothing goes through the API. Every screen goes back to copy, paste and confirm. Messages already sent are not affected, and their delivered and read ticks still arrive."}
      </p>
      {turningOn && !ready ? (
        <Callout tone="warn">
          <span className="text-[13px] text-ink">
            Not everything on the checklist is ready. It can still be switched
            on; messages that cannot go through the API will simply be copied
            and pasted until it is.
          </span>
        </Callout>
      ) : null}
      <label className="mb-1 block text-[13px] font-medium text-ink">Note (optional)</label>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={turningOn ? "e.g. Payment reminder template approved" : "e.g. Pausing during the price revision"}
        className="h-20"
      />
    </Modal>
  );
}

/* ------------------------------------------------------ template linking */

function TemplateLinks({
  crmTemplates,
  watiTemplates,
  mergeFields,
  error,
}: {
  crmTemplates: CrmTemplateRow[];
  watiTemplates: WatiTemplateRow[];
  mergeFields: string[];
  error: string | null;
}) {
  const approved = watiTemplates.filter((t) => t.status === "APPROVED");
  const others = watiTemplates.filter((t) => t.status !== "APPROVED");

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader
        title="Templates"
        hint="Link each CRM template to the approved Wati template it should go out as. The customer receives the Wati wording; the CRM's text is what telecallers preview."
      />
      {error ? (
        <p className="px-5 py-3 text-[13px] text-danger">Could not read templates from Wati: {error}</p>
      ) : null}
      <p className="border-b border-divider px-5 py-3 text-[13px] text-muted">
        In Wati, name the variables the way MahekOne does and they fill
        themselves: {mergeFields.map((f) => `{{${f}}}`).join(" ")}.{" "}
        <span className="font-mono">{"{{name}}"}</span> is read as the customer&rsquo;s name.
        A bill list is sent on one line, separated by &ldquo;|&rdquo;, because WhatsApp
        does not allow line breaks inside a variable.
      </p>
      {crmTemplates.length ? (
        <table className="w-full">
          <thead>
            <tr>
              <Th>CRM template</Th>
              <Th>Sent as (Wati)</Th>
              <Th>Variables</Th>
            </tr>
          </thead>
          <tbody>
            {crmTemplates.map((t) => (
              <LinkRow key={`${t.id}:${t.watiTemplateName ?? ""}`} template={t} approved={approved} mergeFields={mergeFields} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-5 py-4 text-[13px] text-muted">No live templates in the CRM yet.</p>
      )}
      {others.length ? (
        <div className="border-t border-divider px-5 py-3 text-[13px] text-muted">
          Waiting or refused in Wati, so not offered above:{" "}
          {others.map((t) => `${t.name} (${t.status.toLowerCase() || "unknown"})`).join(", ")}
        </div>
      ) : null}
    </Card>
  );
}

function LinkRow({
  template,
  approved,
  mergeFields,
}: {
  template: CrmTemplateRow;
  approved: WatiTemplateRow[];
  mergeFields: string[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [choice, setChoice] = React.useState(template.watiTemplateName ?? "");
  const [busy, setBusy] = React.useState(false);

  const chosen = approved.find((t) => t.name === choice) ?? null;
  const unknown = chosen
    ? chosen.params.filter((p) => !mergeFields.includes(p === "name" ? "customer" : p))
    : [];
  const dirty = choice !== (template.watiTemplateName ?? "");
  // A link to a template Wati no longer shows as approved is kept visible, not
  // silently dropped from the select — sends refuse until it is fixed.
  const stale = template.watiTemplateName && !approved.some((t) => t.name === template.watiTemplateName);

  return (
    <Tr>
      <Td>
        <span className="font-medium text-ink">{template.name}</span>
        <span className="block text-[12px] text-muted">
          {CATEGORY_LABEL[template.category] ?? template.category}
          {template.escalationStage ? ` · stage ${template.escalationStage}` : ""}
        </span>
      </Td>
      <Td>
        <div className="flex items-center gap-2">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)} className="min-w-[220px]">
            <option value="">Not linked — manual only</option>
            {stale ? (
              <option value={template.watiTemplateName!}>{template.watiTemplateName} (no longer approved)</option>
            ) : null}
            {approved.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.language ? ` · ${t.language}` : ""}
              </option>
            ))}
          </Select>
          {dirty ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await run(linkWatiTemplateAction(template.id, choice || null));
                  if (r.ok) router.refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {choice ? "Link" : "Unlink"}
            </Button>
          ) : null}
        </div>
        {chosen?.body ? (
          <span className="mt-1.5 block max-w-[440px] text-[12px] whitespace-pre-wrap text-muted">
            {chosen.body}
          </span>
        ) : null}
      </Td>
      <Td>
        {chosen ? (
          chosen.params.length ? (
            <span className="flex flex-wrap gap-1">
              {chosen.params.map((p) => (
                <Badge key={p} tone={unknown.includes(p) ? "danger" : "success"}>
                  {p}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-[13px] text-muted">None</span>
          )
        ) : (
          <span className="text-[13px] text-muted">-</span>
        )}
        {unknown.length ? (
          <span className="mt-1 block text-[12px] text-danger">
            MahekOne has no field for {unknown.join(", ")} — every send with this would be refused.
          </span>
        ) : null}
      </Td>
    </Tr>
  );
}

/* ------------------------------------------------------------ copy line */

function CopyLine({ value }: { value: string }) {
  const { push } = useToast();
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-[4px] border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink">
        {value}
      </code>
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            push("Copied");
          } catch {
            push("The browser blocked the clipboard — select the address and copy it.", "error");
          }
        }}
      >
        Copy
      </Button>
    </div>
  );
}
