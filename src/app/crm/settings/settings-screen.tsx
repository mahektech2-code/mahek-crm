"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  SectionLabel,
  Select,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { triggerJob, updateConfigSetting } from "@/lib/actions/crm";
import { stamp } from "@/lib/format";

type Setting = {
  key: string;
  type: "integer" | "decimal" | "text" | "boolean" | "structured";
  category: string;
  label: string;
  description: string;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  min: number | null;
  max: number | null;
  options: string[] | null;
  updatedAt: string | null;
};

type Job = {
  id: string;
  job: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  recordsAffected: number;
  detail: string | null;
};

const CATEGORY_LABEL: Record<string, string> = {
  queue: "Call queue",
  "buying-cycle": "Buying cycle",
  "inactive-watch": "Inactive watch",
  escalation: "Payment escalation",
  bills: "Bills and ageing",
  targets: "Monthly targets",
  "working-day": "Working day",
  reminders: "Reminders",
  complaints: "Complaints",
  products: "Products",
  attachments: "Attachments",
  interactions: "Interactions",
  whatsapp: "WhatsApp",
};

const ORDER = [
  "working-day",
  "queue",
  "buying-cycle",
  "escalation",
  "bills",
  "inactive-watch",
  "targets",
  "reminders",
  "complaints",
  "whatsapp",
];

export function SettingsScreen({
  settings,
  warnings,
  jobs,
}: {
  settings: Setting[];
  warnings: string[];
  jobs: Job[];
}) {
  const [tab, setTab] = React.useState<"settings" | "jobs">("settings");

  const categories = React.useMemo(() => {
    const map = new Map<string, Setting[]>();
    for (const s of settings) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return ORDER.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [settings]);

  const changed = settings.filter((s) => !s.isDefault).length;

  return (
    <div className="max-w-[1000px] px-6 pt-6 pb-10">
      <PageHeader
        title="Configuration"
        subtitle="Every threshold the system runs on. Changes take effect on the next read - no restart, no redeploy - and each one is recorded against your name."
      />

      {warnings.length ? (
        <Callout tone="warn">
          <Icon name="alert" size={16} className="mt-0.5 flex-none text-warn-ink" />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-medium text-warn-ink">
              These settings disagree with each other
            </span>
            {warnings.map((w) => (
              <span key={w} className="text-sm text-body">
                {w}
              </span>
            ))}
          </span>
        </Callout>
      ) : null}

      <Card className="mb-4 flex items-center gap-5 px-5 py-3.5">
        <span className="text-sm text-body">
          <strong className="font-semibold text-ink">{settings.length}</strong> settings
        </span>
        <span className="h-4 w-px bg-divider" />
        <span className="text-sm text-body">
          <strong className="font-semibold text-ink">{changed}</strong> changed from the
          shipped default
        </span>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          The defaults are placeholders - every one is expected to be tuned.
        </span>
      </Card>

      <Card className="overflow-hidden">
        <Tabs
          value={tab}
          onChange={setTab}
          className="px-5"
          tabs={[
            { key: "settings", label: "Settings", count: settings.length },
            { key: "jobs", label: "Scheduled work", count: jobs.length },
          ]}
        />

        {tab === "settings" ? (
          <div>
            {categories.map(([category, list]) => (
              <div key={category}>
                <div className="border-y border-divider bg-canvas px-5 py-2">
                  <SectionLabel>{CATEGORY_LABEL[category] ?? category}</SectionLabel>
                </div>
                {list.map((s) => (
                  <SettingRow key={s.key} setting={s} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <JobsTab jobs={jobs} />
        )}
      </Card>
    </div>
  );
}

/** Keyed on the stored value, so a save always leaves a clean, unedited row. */
function SettingRow({ setting }: { setting: Setting }) {
  return <SettingRowBody key={JSON.stringify(setting.value)} setting={setting} />;
}

function SettingRowBody({ setting: s }: { setting: Setting }) {
  const router = useRouter();
  const { run } = useToast();

  const [draft, setDraft] = React.useState(() => toDraft(s));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const dirty = draft !== toDraft(s);

  async function save(next?: string) {
    const raw = next ?? draft;
    const parsed = fromDraft(s, raw);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    const result = await run(updateConfigSetting(s.key, parsed.value));
    setBusy(false);
    if (result.ok) {
      setError(null);
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="flex items-start gap-5 border-b border-divider px-5 py-3.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{s.label}</span>
          {s.isDefault ? (
            <Badge tone="muted">Default</Badge>
          ) : (
            <Badge tone="brand">Changed</Badge>
          )}
        </div>
        <p className="mt-0.5 text-[13px] leading-5 text-muted">{s.description}</p>
        <p className="mt-0.5 font-mono text-[11px] text-line-strong">
          {s.key}
          {s.updatedAt ? ` · last changed ${stamp(s.updatedAt)}` : ""}
        </p>
        {error ? <p className="mt-1 text-[13px] text-danger">{error}</p> : null}
      </div>

      <div className="w-[280px] flex-none">
        {s.type === "boolean" ? (
          <Checkbox
            label={draft === "true" ? "On" : "Off"}
            checked={draft === "true"}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.checked ? "true" : "false";
              setDraft(next);
              void save(next);
            }}
          />
        ) : s.options ? (
          <Select
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              void save(e.target.value);
            }}
          >
            {s.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        ) : s.type === "structured" ? (
          <Field
            label="Value"
            hint="JSON - the shape must match what the engine expects"
            className="mb-0"
          >
            <Textarea
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              className="h-20 font-mono text-[12px]"
            />
          </Field>
        ) : (
          <Field
            label="Value"
            hint={
              s.min !== null && s.max !== null ? `Between ${s.min} and ${s.max}` : undefined
            }
            className="mb-0"
          >
            <Input
              type="number"
              value={draft}
              disabled={busy}
              step={s.type === "decimal" ? "0.01" : "1"}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
        )}

        {dirty && s.type !== "boolean" && !s.options ? (
          <div className="mt-1.5 flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => save()}>
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDraft(toDraft(s))}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function toDraft(s: Setting): string {
  if (s.type === "structured") return JSON.stringify(s.value, null, 2);
  return String(s.value);
}

/** Client-side parsing only. The server validates again and has the last word. */
function fromDraft(
  s: Setting,
  draft: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (s.type === "boolean") return { ok: true, value: draft === "true" };
  if (s.type === "text") return { ok: true, value: draft };
  if (s.type === "structured") {
    try {
      return { ok: true, value: JSON.parse(draft) };
    } catch {
      return { ok: false, error: "That is not valid JSON." };
    }
  }
  const n = Number(draft);
  if (!Number.isFinite(n)) return { ok: false, error: "Enter a number." };
  if (s.type === "integer" && !Number.isInteger(n)) {
    return { ok: false, error: "Enter a whole number." };
  }
  return { ok: true, value: n };
}

/* --------------------------------------------------------------- jobs tab */

const JOBS = [
  {
    key: "nightly" as const,
    label: "Nightly",
    blurb:
      "Recomputes buying cycles, the inactive watch, follow-up stages and slow payers.",
  },
  {
    key: "hourly" as const,
    label: "Hourly",
    blurb: "Sweeps unconfirmed WhatsApp copies and escalates complaints past their SLA.",
  },
  {
    key: "day-boundary" as const,
    label: "Day boundary",
    blurb: "Generates EOD reports and rolls pending reminders off non-working days.",
  },
];

function JobsTab({ jobs }: { jobs: Job[] }) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  return (
    <div>
      <div className="border-b border-divider px-5 py-4">
        <p className="mb-3 text-[13px] text-muted">
          Every task is safe to re-run. If a nightly run was missed, or a threshold above
          has just changed, run it by hand rather than waiting.
        </p>
        <div className="flex flex-wrap gap-2">
          {JOBS.map((j) => (
            <Button
              key={j.key}
              variant="secondary"
              disabled={busy !== null}
              title={j.blurb}
              onClick={async () => {
                setBusy(j.key);
                await run(triggerJob(j.key));
                setBusy(null);
                router.refresh();
              }}
            >
              {busy === j.key ? `Running ${j.label}…` : `Run ${j.label}`}
            </Button>
          ))}
        </div>
      </div>

      {jobs.length ? (
        jobs.map((j) => (
          <div
            key={j.id}
            className="flex items-center gap-4 border-b border-divider px-5 py-3 last:border-0"
          >
            <span
              className={cx(
                "block h-2 w-2 flex-none rounded-full",
                j.finishedAt === null ? "bg-warn" : j.ok ? "bg-success" : "bg-danger",
              )}
            />
            <span className="w-[190px] flex-none text-sm font-medium text-ink">
              {j.job}
            </span>
            <span className="flex-1 truncate text-[13px] text-muted">
              {j.detail ?? (j.finishedAt ? "" : "still running")}
            </span>
            <span className="w-[70px] flex-none text-right text-[13px] text-body">
              {j.recordsAffected}
            </span>
            <span className="w-[130px] flex-none text-right text-[13px] text-muted">
              {stamp(j.startedAt)}
            </span>
          </div>
        ))
      ) : (
        <div className="px-5 py-8 text-center text-sm text-muted">
          Nothing has run yet.
        </div>
      )}
    </div>
  );
}
