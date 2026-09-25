"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Input,
  PageHeader,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog, Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import {
  checkTimes,
  describeRule,
  describeWindow,
  hourLabel,
  validateRule,
  validateWindow,
  WEEKDAY_NAMES,
  type RuleStatus,
  type WindowSettings,
} from "@/lib/whatsapp-rules";
import {
  deleteRuleAction,
  previewAutomationAction,
  runLiveNowAction,
  saveRuleAction,
  saveWindowAction,
  setRuleStatusAction,
} from "@/lib/actions/whatsapp-founder";
import type { RunSummary } from "@/lib/services/whatsapp-automation-service";
import { WhatsappTabs } from "../whatsapp-tabs";

/* ---------------------------------------------------------------------------
 * The founder's automation screen.
 *
 * EVERY RULE IS READ BACK AS A SENTENCE. The fields are how it is changed;
 * the sentence is how it is checked — "Sent between 16 and 29 days overdue,
 * every 4 days" is what somebody actually agrees to, and it is produced by
 * the same function the runner's behaviour is described by.
 *
 * Off / Preview / Live is one control per rule. Preview is the safe way to
 * turn a rule on: it runs every scheduled check, writes who WOULD have been
 * sent what into the run log below, and sends nothing.
 * ------------------------------------------------------------------------- */

type RuleView = {
  id: string;
  templateId: string;
  templateName: string;
  linked: boolean;
  kind: "payment" | "order";
  status: RuleStatus;
  fromDay: number;
  toDay: number | null;
  repeatEveryDays: number;
  maxSends: number | null;
  minAmountPaise: number | null;
  priority: number;
  updatedByName: string | null;
  updatedAt: string;
  sentLast7: number;
};

type TemplateOption = { id: string; name: string; kind: "payment" | "order"; linked: boolean };
type RunView = { id: string; startedAt: string; source: string; note: string | null; summary: RunSummary };

const STATUS: Array<{ key: RuleStatus; label: string }> = [
  { key: "off", label: "Off" },
  { key: "preview", label: "Preview" },
  { key: "live", label: "Live" },
];

export function AutomationControl(props: {
  settings: WindowSettings;
  serviceOn: boolean;
  rules: RuleView[];
  templates: TemplateOption[];
  runs: RunView[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [editing, setEditing] = React.useState<RuleView | "new-payment" | "new-order" | null>(null);
  const [goLive, setGoLive] = React.useState<RuleView | null>(null);
  const [removing, setRemoving] = React.useState<RuleView | null>(null);
  const [result, setResult] = React.useState<RunSummary | null>(null);
  const [busy, setBusy] = React.useState(false);

  const live = props.rules.filter((r) => r.status === "live").length;
  const preview = props.rules.filter((r) => r.status === "preview").length;

  async function setStatus(r: RuleView, status: RuleStatus) {
    if (status === "live") return setGoLive(r);
    const res = await run(setRuleStatusAction(r.id, status));
    if (res.ok) router.refresh();
  }

  async function doPreview(ruleIds?: string[]) {
    setBusy(true);
    try {
      const r = await run(previewAutomationAction(ruleIds));
      if (r.ok) {
        setResult(r.data);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title="WhatsApp"
        subtitle="Rules that send the approved templates on their own — when each one fires, how often, and the hours anything may go out."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => doPreview()}>
              {busy ? "Working…" : "Preview now"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !live}
              title={live ? "Runs the Live rules now — only inside the sending window" : "No rule is Live"}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await run(runLiveNowAction());
                  if (r.ok) {
                    setResult(r.data.runId ? r.data : null);
                    router.refresh();
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              Run live rules now
            </Button>
          </div>
        }
      />
      <WhatsappTabs current="automation" />

      {!props.serviceOn && live ? (
        <Callout tone="warn">
          <span className="text-[13px] text-ink">
            WhatsApp sending is switched off on the Setup tab, so the {live} Live rule{live === 1 ? " is" : "s are"}{" "}
            only being worked out and logged — nothing is sent until it is switched on there.
          </span>
        </Callout>
      ) : null}

      <WindowCard settings={props.settings} live={live} preview={preview} />

      <RuleGroup
        title="Payment reminders"
        hint="Counted in days OVERDUE — from the due date of the customer's oldest unpaid bill."
        rules={props.rules.filter((r) => r.kind === "payment")}
        onAdd={() => setEditing("new-payment")}
        onEdit={setEditing}
        onRemove={setRemoving}
        onStatus={setStatus}
        onPreview={(r) => doPreview([r.id])}
        busy={busy}
      />
      <RuleGroup
        title="Order follow-ups"
        hint="Counted in days from the EXPECTED ORDER DATE — last order plus the customer's measured buying cycle. Negative is before it."
        rules={props.rules.filter((r) => r.kind === "order")}
        onAdd={() => setEditing("new-order")}
        onEdit={setEditing}
        onRemove={setRemoving}
        onStatus={setStatus}
        onPreview={(r) => doPreview([r.id])}
        busy={busy}
      />

      <p className="-mt-2 mb-4 text-[13px] text-muted">
        One message per customer per day. When a customer matches several rules, the lowest priority number wins
        and the others wait. Every message is still checked against the template&rsquo;s own rules — a customer who
        has reported a payment, has no measured buying cycle or is marked do not contact is never sent one.
      </p>

      {result ? <RunDetail run={result} title="Just now" onClose={() => setResult(null)} /> : null}

      <RunsCard runs={props.runs} />

      {editing ? (
        <RuleModal
          key={typeof editing === "string" ? editing : editing.id}
          rule={typeof editing === "string" ? null : editing}
          kind={typeof editing === "string" ? (editing === "new-payment" ? "payment" : "order") : editing.kind}
          templates={props.templates}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(goLive)}
        title={`Make "${goLive?.templateName}" live?`}
        body={
          <span className="block text-sm text-body">
            {goLive ? describeRule(goLive) : ""} From the next scheduled check, matching customers are sent this
            message from the business number — {describeWindow(props.settings)}.
            {!goLive?.linked ? " This template is not linked to its approved Wati template yet, so nothing can go until it is (Setup tab)." : ""}
            {!props.serviceOn ? " WhatsApp sending is switched off, so it will only be logged until that is switched on." : ""}
          </span>
        }
        confirmLabel="Make it live"
        onConfirm={async () => {
          if (!goLive) return;
          const res = await run(setRuleStatusAction(goLive.id, "live"));
          if (res.ok) router.refresh();
        }}
        onClose={() => setGoLive(null)}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        title="Delete this rule?"
        body={<span className="block text-sm text-body">{removing ? `${removing.templateName}: ${describeRule(removing)}` : ""} Messages it already sent stay in the log.</span>}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          const res = await run(deleteRuleAction(removing.id));
          if (res.ok) router.refresh();
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

/* ----------------------------------------------------------- the window */

function WindowCard({ settings, live, preview }: { settings: WindowSettings; live: number; preview: number }) {
  const router = useRouter();
  const { run } = useToast();
  const [w, setW] = React.useState(settings);
  const [saving, setSaving] = React.useState(false);
  const problems = validateWindow(w);
  const dirty = JSON.stringify(w) !== JSON.stringify(settings);
  const times = checkTimes(w);

  return (
    <Card className="mb-4">
      <CardHeader
        title="When messages go out"
        hint={`${live} live · ${preview} in preview · checked ${times.length === 1 ? "once" : `${times.length} times`} a day, at ${times.join(", ")} IST`}
      />
      <div className="flex flex-wrap items-end gap-5 px-5 py-4">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">From</span>
          <Select value={w.windowStartHour} onChange={(e) => setW({ ...w, windowStartHour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Until</span>
          <Select value={w.windowEndHour} onChange={(e) => setW({ ...w, windowEndHour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </Select>
        </label>
        <div>
          <span className="mb-1 block text-[13px] font-medium text-ink">Days</span>
          <div className="flex gap-1">
            {WEEKDAY_NAMES.map((name, i) => {
              const d = i + 1;
              const on = w.weekdays.includes(d);
              return (
                <button
                  key={name}
                  onClick={() => setW({ ...w, weekdays: on ? w.weekdays.filter((x) => x !== d) : [...w.weekdays, d] })}
                  className={cx(
                    "h-9 w-11 cursor-pointer rounded-[4px] border text-[13px]",
                    on ? "border-brand bg-brand-soft font-medium text-ink" : "border-line bg-surface text-muted hover:bg-canvas",
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Most per day</span>
          <Input
            type="number"
            min={1}
            className="w-24"
            value={w.dailyCap}
            onChange={(e) => setW({ ...w, dailyCap: Number(e.target.value) })}
          />
        </label>
        <Button
          disabled={!dirty || problems.length > 0 || saving}
          title={problems.join(" ") || undefined}
          onClick={async () => {
            setSaving(true);
            try {
              const r = await run(saveWindowAction(w));
              if (r.ok) router.refresh();
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </Button>
      </div>
      <div className="border-t border-divider px-5 py-3 text-[13px] text-muted">
        {problems.length ? (
          <span className="text-danger">{problems.join(" ")}</span>
        ) : (
          <>
            Messages go out <span className="font-medium text-ink">{describeWindow(w)}</span>, and never outside it —
            the window is checked again before every single message, so a long run stops at the boundary.
          </>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ the rules */

function RuleGroup(props: {
  title: string;
  hint: string;
  rules: RuleView[];
  onAdd: () => void;
  onEdit: (r: RuleView) => void;
  onRemove: (r: RuleView) => void;
  onStatus: (r: RuleView, s: RuleStatus) => void;
  onPreview: (r: RuleView) => void;
  busy: boolean;
}) {
  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader
        title={props.title}
        hint={props.hint}
        action={
          <Button size="sm" variant="secondary" onClick={props.onAdd}>
            + Add a rule
          </Button>
        }
      />
      {props.rules.length ? (
        <table className="w-full">
          <thead>
            <tr>
              <Th>Template</Th>
              <Th>When it goes</Th>
              <Th align="right">Priority</Th>
              <Th align="right">Sent · 7 days</Th>
              <Th>Status</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {props.rules.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <span className="font-medium text-ink">{r.templateName}</span>
                  {!r.linked ? (
                    <span className="mt-0.5 block text-[12px] text-warn-ink" title="Link it on the Setup tab">
                      Not linked to Wati yet
                    </span>
                  ) : null}
                </Td>
                <Td className="max-w-[420px] text-[13px] text-body">{describeRule(r)}</Td>
                <Td align="right">{r.priority}</Td>
                <Td align="right">{r.sentLast7}</Td>
                <Td>
                  <div className="inline-flex overflow-hidden rounded-[4px] border border-line">
                    {STATUS.map((s) => (
                      <button
                        key={s.key}
                        onClick={() => r.status !== s.key && props.onStatus(r, s.key)}
                        className={cx(
                          "h-7 cursor-pointer px-2.5 text-[12px]",
                          r.status === s.key
                            ? s.key === "live"
                              ? "bg-success text-white"
                              : s.key === "preview"
                                ? "bg-brand-soft font-medium text-ink"
                                : "bg-canvas font-medium text-ink"
                            : "bg-surface text-muted hover:bg-canvas",
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-3 text-[13px] whitespace-nowrap">
                    <button className="cursor-pointer text-brand disabled:text-muted" disabled={props.busy} onClick={() => props.onPreview(r)}>
                      Preview
                    </button>
                    <button className="cursor-pointer text-brand" onClick={() => props.onEdit(r)}>
                      Edit
                    </button>
                    <button className="cursor-pointer text-danger" onClick={() => props.onRemove(r)}>
                      Delete
                    </button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-5 py-4 text-[13px] text-muted">No rules yet.</p>
      )}
    </Card>
  );
}

/* --------------------------------------------------------- the editor */

function RuleModal({
  rule,
  kind,
  templates,
  onClose,
}: {
  rule: RuleView | null;
  kind: "payment" | "order";
  templates: TemplateOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { run } = useToast();
  const options = templates.filter((t) => t.kind === kind);
  const [templateId, setTemplateId] = React.useState(rule?.templateId ?? options[0]?.id ?? "");
  const [fromDay, setFromDay] = React.useState(String(rule?.fromDay ?? (kind === "payment" ? 1 : 0)));
  const [toDay, setToDay] = React.useState(rule?.toDay === null || rule === null ? "" : String(rule.toDay));
  const [repeat, setRepeat] = React.useState(String(rule?.repeatEveryDays ?? (kind === "payment" ? 4 : 30)));
  const [maxSends, setMaxSends] = React.useState(rule?.maxSends ? String(rule.maxSends) : "");
  const [minAmount, setMinAmount] = React.useState(rule?.minAmountPaise ? String(rule.minAmountPaise / 100) : "");
  const [priority, setPriority] = React.useState(String(rule?.priority ?? 100));
  const [saving, setSaving] = React.useState(false);

  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const draft = {
    kind,
    status: rule?.status ?? ("off" as RuleStatus),
    fromDay: Number(fromDay),
    toDay: num(toDay),
    repeatEveryDays: Number(repeat),
    maxSends: num(maxSends),
    minAmountPaise: kind === "payment" && num(minAmount) !== null ? Math.round(Number(minAmount) * 100) : null,
    priority: Number(priority),
  };
  const problems = [
    ...(templateId ? [] : ["Pick a template."]),
    ...validateRule(draft),
  ];
  const dayWord = kind === "payment" ? "days overdue" : "days from the expected order date";

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={rule ? `Edit rule · ${rule.templateName}` : kind === "payment" ? "New payment rule" : "New order rule"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            disabled={problems.length > 0 || saving}
            onClick={async () => {
              setSaving(true);
              try {
                const r = await run(saveRuleAction({ id: rule?.id, templateId, ...draft }));
                if (r.ok) {
                  onClose();
                  router.refresh();
                }
              } finally {
                setSaving(false);
              }
            }}
          >
            {rule ? "Save rule" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <label className="col-span-2 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Template</span>
          <Select value={templateId} disabled={Boolean(rule)} onChange={(e) => setTemplateId(e.target.value)}>
            {options.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.linked ? "" : " (not linked to Wati yet)"}</option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">From ({dayWord})</span>
          <Input type="number" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Until (blank = no end)</span>
          <Input type="number" value={toDay} onChange={(e) => setToDay(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Repeat every (days)</span>
          <Input type="number" min={1} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">At most (times, blank = no limit)</span>
          <Input type="number" min={1} value={maxSends} onChange={(e) => setMaxSends(e.target.value)} />
        </label>
        {kind === "payment" ? (
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">Only if overdue is at least ₹ (blank = any)</span>
            <Input type="number" min={0} value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
          </label>
        ) : null}
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Priority (1 goes first)</span>
          <Input type="number" min={1} value={priority} onChange={(e) => setPriority(e.target.value)} />
        </label>
      </div>
      <div
        className={cx(
          "mt-4 rounded-[6px] border px-3 py-2.5 text-[13px]",
          problems.length ? "border-danger-soft bg-danger-soft text-danger" : "border-brand-softer bg-brand-soft text-ink",
        )}
      >
        {problems.length ? problems.join(" ") : describeRule(draft)}
      </div>
      {kind === "order" ? (
        <p className="mt-2 text-[12px] text-muted">
          Example: from -2 until 0 is &ldquo;two days before the order is due, up to the day&rdquo;. A customer is only
          ever counted from their own measured buying cycle.
        </p>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------- the log */

const OUTCOME: Record<string, { label: string; tone: "success" | "brand" | "danger" | "muted" | "warn" }> = {
  sent: { label: "Sent", tone: "success" },
  would_send: { label: "Would send", tone: "brand" },
  failed: { label: "Failed", tone: "danger" },
  refused: { label: "Refused", tone: "warn" },
  skipped: { label: "Skipped", tone: "muted" },
};

function RunDetail({ run, title, onClose }: { run: RunSummary; title: string; onClose?: () => void }) {
  const [open, setOpen] = React.useState<string | null>(run.rules.find((r) => r.rows.length)?.ruleId ?? null);
  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader
        title={`${title} — ${run.sent} sent · ${run.wouldSend} would send`}
        hint={run.note}
        action={onClose ? <Button size="sm" variant="secondary" onClick={onClose}>Close</Button> : undefined}
      />
      {run.rules.map((r) => (
        <div key={r.ruleId} className="border-b border-divider last:border-0">
          <button
            onClick={() => setOpen(open === r.ruleId ? null : r.ruleId)}
            className="flex w-full cursor-pointer items-center gap-3 px-5 py-2.5 text-left hover:bg-canvas"
          >
            <span className="min-w-0 flex-1 text-sm font-medium text-ink">{r.templateName}</span>
            <span className="text-[12px] text-muted">
              {r.inRange} in range · {r.sent} sent · {r.wouldSend} would send · {r.refused} refused · {r.skipped} skipped
              {r.failed ? ` · ${r.failed} failed` : ""}
            </span>
            <span className="text-muted">{open === r.ruleId ? "▾" : "▸"}</span>
          </button>
          {open === r.ruleId && r.rows.length ? (
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th align="right">Day</Th>
                  <Th>Outcome</Th>
                  <Th>Why</Th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row, i) => (
                  <Tr key={`${row.customerId}:${i}`}>
                    <Td className="font-medium text-ink">{row.customerName}</Td>
                    <Td align="right">{row.day}</Td>
                    <Td>
                      <Badge tone={OUTCOME[row.outcome]?.tone ?? "muted"}>{OUTCOME[row.outcome]?.label ?? row.outcome}</Badge>
                    </Td>
                    <Td className="max-w-[520px] text-[13px] text-muted">{row.reason ?? ""}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ))}
    </Card>
  );
}

function RunsCard({ runs }: { runs: RunView[] }) {
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Recent runs" hint="Every scheduled check and every preview, with what each rule did or would have done." />
      {runs.length ? (
        <table className="w-full">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Kind</Th>
              <Th align="right">Sent</Th>
              <Th align="right">Would send</Th>
              <Th>Note</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <React.Fragment key={r.id}>
                <Tr>
                  <Td className="whitespace-nowrap">{stamp(r.startedAt)}</Td>
                  <Td>{r.source === "preview" ? "Preview" : "Scheduled"}</Td>
                  <Td align="right">{r.summary.sent}</Td>
                  <Td align="right">{r.summary.wouldSend}</Td>
                  <Td className="text-[13px] text-muted">{r.note}</Td>
                  <Td>
                    <button className="cursor-pointer text-[13px] text-brand" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? "Hide" : "Details"}
                    </button>
                  </Td>
                </Tr>
                {open === r.id ? (
                  <tr>
                    <td colSpan={6} className="bg-canvas p-3">
                      <RunDetail run={r.summary} title={stamp(r.startedAt)} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-5 py-4 text-[13px] text-muted">Nothing has run yet. Press Preview now to see who each rule would reach today.</p>
      )}
    </Card>
  );
}
