"use client";

import * as React from "react";
import Link from "next/link";
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
import {
  ConfirmDialog,
  Drawer,
  DrawerHeader,
  FilterPills,
  Modal,
  RowMenu,
} from "@/components/ui/overlays";
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
  founderPreviewAction,
  previewAutomationAction,
  ruleAudienceAction,
  runLiveNowAction,
  saveRuleAction,
  saveWindowAction,
  setRuleStatusAction,
} from "@/lib/actions/whatsapp-founder";
import type { RunSummary } from "@/lib/services/whatsapp-automation-service";
import type { MessagePreview } from "@/lib/services/whatsapp-service";
import { WhatsappTabs } from "../whatsapp-tabs";
import { MessagePreviewView } from "../message-preview";

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
  /** The founder's own number, offered for "Send test to me". */
  myPhone: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [editing, setEditing] = React.useState<RuleView | "new-payment" | "new-order" | null>(null);
  /* The panel holds a rule by id, so a refresh after a save shows the rule as
     it now is rather than the copy that was clicked. */
  const [openId, setOpenId] = React.useState<string | null>(null);
  const opened = openId ? props.rules.find((r) => r.id === openId) ?? null : null;
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

      <Readiness
        linked={props.templates.filter((t) => t.linked).length}
        templates={props.templates.length}
        serviceOn={props.serviceOn}
        live={live}
        tried={preview > 0 || props.runs.some((r) => r.source === "preview")}
      />

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
        onOpen={(r) => setOpenId(r.id)}
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
        onOpen={(r) => setOpenId(r.id)}
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

      {opened ? (
        <RulePanel
          /* Prefixed: the editor below sits beside the panel and is keyed on
             the same rule id — two siblings with one key made React draw the
             panel twice the moment Edit was pressed. */
          key={`panel:${opened.id}`}
          rule={opened}
          myPhone={props.myPhone}
          /* Escape inside the editor closes the editor, not the panel behind
             it, and the same for the two confirmations it can open: both listen,
             and this one steps aside while either is up. */
          onClose={() => {
            if (!editing && !goLive && !removing) setOpenId(null);
          }}
          onEdit={() => setEditing(opened)}
          onRemove={() => setRemoving(opened)}
          onStatus={(s) => setStatus(opened, s)}
        />
      ) : null}

      {editing ? (
        <RuleModal
          key={`edit:${typeof editing === "string" ? editing : editing.id}`}
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
          if (res.ok) {
            if (openId === removing.id) setOpenId(null);
            router.refresh();
          }
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
  onOpen: (r: RuleView) => void;
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
        <div className="overflow-x-auto"><table className="w-full">
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
                  {/* The name OPENS the rule — the panel is where a rule is
                      understood before it is changed. */}
                  <button
                    onClick={() => props.onOpen(r)}
                    className="cursor-pointer text-left font-medium text-ink hover:text-brand hover:underline"
                  >
                    {r.templateName}
                  </button>
                  {!r.linked ? (
                    <span className="mt-0.5 block text-[12px] text-warn-ink" title="Link it on the Setup tab">
                      Not linked to Wati yet
                    </span>
                  ) : null}
                </Td>
                {/* Wraps. Cells here hold their line by default, which ran
                    this sentence straight over the Priority column. */}
                <Td className="min-w-[260px] max-w-[420px] text-[13px] whitespace-normal text-body">{describeRule(r)}</Td>
                <Td align="right">{r.priority}</Td>
                <Td align="right">{r.sentLast7}</Td>
                <Td>
                  <StatusControl status={r.status} onChange={(s) => props.onStatus(r, s)} />
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => props.onOpen(r)}>
                      Open
                    </Button>
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => props.onEdit(r) },
                        {
                          label: "Preview in the log",
                          onSelect: () => props.onPreview(r),
                          disabled: props.busy,
                          title: "Works this rule out now and adds the result to Recent runs",
                        },
                        { label: "Delete", onSelect: () => props.onRemove(r), destructive: true },
                      ]}
                    />
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table></div>
      ) : (
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <p className="text-[13px] text-muted">No rules yet — nothing of this kind is sent automatically.</p>
          <Button size="sm" onClick={props.onAdd}>Add the first rule</Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Off / Preview / Live, as one control. Drawn as three real buttons with the
 * chosen one filled, because as muted words it read as a label rather than a
 * thing that could be pressed.
 */
function StatusControl({
  status,
  onChange,
}: {
  status: RuleStatus;
  onChange: (s: RuleStatus) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-[4px] border border-line-strong" role="radiogroup" aria-label="Rule status">
      {STATUS.map((s) => {
        const on = status === s.key;
        return (
          <button
            key={s.key}
            role="radio"
            aria-checked={on}
            onClick={() => !on && onChange(s.key)}
            title={
              s.key === "off"
                ? "Not checked by the schedule at all"
                : s.key === "preview"
                  ? "Checked on schedule and logged as 'would send' — nothing goes to customers"
                  : "Sends to customers on schedule, inside the window"
            }
            className={cx(
              "h-8 cursor-pointer border-l border-line-strong px-3 text-[13px] first:border-l-0",
              on
                ? s.key === "live"
                  ? "bg-success font-medium text-white"
                  : s.key === "preview"
                    ? "bg-brand font-medium text-white"
                    : "bg-ink font-medium text-white"
                : "bg-surface text-body hover:bg-canvas",
            )}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ readiness */

/**
 * WHAT STANDS BETWEEN THESE RULES AND A CUSTOMER'S PHONE, in order.
 *
 * Every rule on this screen can be set, previewed and switched to Live while
 * nothing at all can reach a customer — the templates unlinked, or sending
 * switched off on the Setup tab — and the screen used to say so only in a
 * small warning under each template's name. From the founder's chair that
 * reads as a screen whose buttons do nothing. So the four steps are said at
 * the top, each with where it is done, and the strip steps aside once all
 * four are true.
 */
function Readiness({
  linked,
  templates,
  serviceOn,
  live,
  tried,
}: {
  linked: number;
  templates: number;
  serviceOn: boolean;
  live: number;
  tried: boolean;
}) {
  const steps = [
    {
      done: templates > 0 && linked === templates,
      title: "Link the templates to Wati",
      detail: `${linked} of ${templates} linked. An unlinked template can be previewed but never sent.`,
      href: "/founder/whatsapp",
      cta: "Link on Setup",
    },
    {
      done: serviceOn,
      title: "Switch WhatsApp sending on",
      detail: serviceOn ? "On." : "Off — Live rules are worked out and logged, but nothing is sent.",
      href: "/founder/whatsapp",
      cta: "Open Setup",
    },
    {
      done: tried,
      title: "Try a rule in Preview",
      detail: "Open a rule to see exactly who it reaches today and what each of them would get.",
    },
    {
      done: live > 0,
      title: "Make a rule Live",
      detail: live ? `${live} Live.` : "Nothing is sent automatically until a rule is Live.",
    },
  ];
  if (steps.every((s) => s.done)) return null;
  const next = steps.findIndex((s) => !s.done);

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader
        title="Before anything is sent"
        hint="Automatic messages need all four. Until then these rules can be set up and previewed safely."
      />
      <ol className="grid grid-cols-1 md:grid-cols-4">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className={cx(
              "flex gap-3 border-t border-divider px-5 py-3.5 md:border-l md:first:border-l-0",
              i === next ? "bg-brand-soft" : "",
            )}
          >
            <span
              className={cx(
                "mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-[12px] font-semibold",
                s.done ? "bg-success text-white" : i === next ? "bg-brand text-white" : "bg-divider text-muted",
              )}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">{s.title}</span>
              <span className="mt-0.5 block text-[13px] text-muted">{s.detail}</span>
              {!s.done && s.href ? (
                <Link href={s.href} className="mt-1.5 inline-block text-[13px] font-medium text-brand">
                  {s.cta} →
                </Link>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/* ------------------------------------------------------------ the panel */

type AudienceFilter = "would_send" | "refused" | "skipped";

/**
 * ONE RULE, UNDERSTOOD BEFORE IT IS CHANGED.
 *
 * What it says in a sentence, who it reaches TODAY — every customer in its
 * range and what would happen to each — and, for any of them, the exact
 * message they would get, with a test send to your own phone. The audience is
 * worked out fresh on every open and logged nowhere (`ruleAudience`), so
 * looking is free and the run log stays a record of real checks.
 */
function RulePanel({
  rule,
  myPhone,
  onClose,
  onEdit,
  onRemove,
  onStatus,
}: {
  rule: RuleView;
  myPhone: string;
  onClose: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onStatus: (s: RuleStatus) => void;
}) {
  const [stats, setStats] = React.useState<RunSummary["rules"][number] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<AudienceFilter>("would_send");
  const [picked, setPicked] = React.useState<{ id: string; name: string } | null>(null);
  const [preview, setPreview] = React.useState<MessagePreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const show = React.useCallback(
    async (customer: { id: string; name: string }) => {
      setPicked(customer);
      setPreview(null);
      setPreviewing(true);
      try {
        const r = await founderPreviewAction(customer.id, rule.templateId);
        setPreview(r.ok ? r.data : { ok: false, reasons: [r.error] });
      } finally {
        setPreviewing(false);
      }
    },
    [rule.templateId],
  );

  React.useEffect(() => {
    let live = true;
    void ruleAudienceAction(rule.id).then((r) => {
      if (!live) return;
      if (!r.ok) return setLoadError(r.error);
      const mine = r.data.rules.find((x) => x.ruleId === rule.id) ?? null;
      setStats(mine);
      /* Open on somebody it WOULD send to, so the message is on screen
         without a click — the question most people open a rule to answer. */
      const first = mine?.rows.find((x) => x.outcome === "would_send");
      if (first) void show({ id: first.customerId, name: first.customerName });
    });
    return () => {
      live = false;
    };
  }, [rule.id, show]);

  const rows = (stats?.rows ?? []).filter((r) =>
    filter === "would_send" ? r.outcome === "would_send" || r.outcome === "sent" : r.outcome === filter,
  );
  const dayWord = rule.kind === "payment" ? "days overdue" : "day vs expected order";

  return (
    <Drawer open onClose={onClose} width={720} label={rule.templateName}>
      <DrawerHeader onClose={onClose}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold text-ink">{rule.templateName}</span>
          <Badge tone={rule.kind === "payment" ? "warn" : "brand"}>
            {rule.kind === "payment" ? "Payment reminder" : "Order follow-up"}
          </Badge>
        </div>
        <p className="mt-1 text-[13px] text-body">{describeRule(rule)}</p>
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto">
        {!rule.linked ? (
          <div className="border-b border-divider px-5 py-3">
            <Callout tone="warn">
              <span className="text-[13px] text-ink">
                Not linked to its approved Wati template, so this rule can be previewed but never sent.{" "}
                <Link href="/founder/whatsapp" className="font-medium text-brand">Link it on Setup →</Link>
              </span>
            </Callout>
          </div>
        ) : null}

        <section className="flex flex-wrap items-center gap-3 border-b border-divider px-5 py-4">
          <StatusControl status={rule.status} onChange={onStatus} />
          <span className="text-[13px] text-muted">
            Priority {rule.priority} · {rule.sentLast7} sent in 7 days
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={onEdit}>Edit rule</Button>
          <Button size="sm" variant="danger" onClick={onRemove}>Delete</Button>
        </section>

        <section className="border-b border-divider px-5 py-4">
          <h3 className="text-sm font-semibold text-ink">Who it reaches today</h3>
          {loadError ? (
            <p className="mt-2 text-[13px] text-danger">{loadError}</p>
          ) : !stats ? (
            <p className="mt-2 text-[13px] text-muted">Working it out from today&rsquo;s bills and orders…</p>
          ) : (
            <>
              <p className="mt-1 text-[13px] text-muted">
                {stats.inRange} customer{stats.inRange === 1 ? "" : "s"} in range today. Worked out now — nothing is sent
                and nothing is logged.
              </p>
              <div className="mt-3">
                <FilterPills<AudienceFilter>
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { key: "would_send", label: "Would get it", count: stats.wouldSend + stats.sent },
                    { key: "refused", label: "Refused", count: stats.refused },
                    { key: "skipped", label: "Skipped", count: stats.skipped },
                  ]}
                />
              </div>
              {rows.length ? (
                <div className="mt-3 max-h-[260px] overflow-y-auto rounded-[4px] border border-line">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <Th>Customer</Th>
                        <Th align="right">{dayWord}</Th>
                        <Th>{filter === "would_send" ? "" : "Why"}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const on = picked?.id === row.customerId;
                        return (
                          <Tr key={`${row.customerId}:${i}`}>
                            <Td>
                              <button
                                onClick={() => void show({ id: row.customerId, name: row.customerName })}
                                className={cx(
                                  "cursor-pointer text-left hover:text-brand hover:underline",
                                  on ? "font-semibold text-brand" : "font-medium text-ink",
                                )}
                              >
                                {row.customerName}
                              </button>
                            </Td>
                            <Td align="right">{row.day}</Td>
                            <Td className="text-[13px] whitespace-normal text-muted">
                              {filter === "would_send" ? (on ? "Showing below" : "See the message") : row.reason}
                            </Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-muted">
                  {filter === "would_send"
                    ? "Nobody today — widen the day range, or check the Refused and Skipped lists for why."
                    : "Nobody."}
                </p>
              )}
              {stats.rows.length >= 150 ? (
                <p className="mt-2 text-[12px] text-muted">Showing the first 150 customers; the counts above are the full figures.</p>
              ) : null}
            </>
          )}
        </section>

        <section className="px-5 py-4">
          <h3 className="text-sm font-semibold text-ink">
            {picked ? `What ${picked.name} would get` : "The message"}
          </h3>
          <div className="mt-2">
            {previewing ? (
              <p className="text-[13px] text-muted">Filling it in from their bills and orders…</p>
            ) : preview && picked ? (
              <MessagePreviewView
                key={picked.id}
                preview={preview}
                customerId={picked.id}
                customerName={picked.name}
                templateId={rule.templateId}
                linked={rule.linked}
                defaultPhone={myPhone}
              />
            ) : (
              <p className="text-[13px] text-muted">Pick a customer above to see the exact message they would receive.</p>
            )}
          </div>
        </section>
      </div>
    </Drawer>
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
            <div className="overflow-x-auto"><table className="w-full">
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
            </table></div>
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
        <div className="overflow-x-auto"><table className="w-full">
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
        </table></div>
      ) : (
        <p className="px-5 py-4 text-[13px] text-muted">Nothing has run yet. Press Preview now to see who each rule would reach today.</p>
      )}
    </Card>
  );
}
