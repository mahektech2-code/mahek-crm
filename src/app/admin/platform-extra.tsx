"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Input,
  Progress,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { CRM_SCHEMA, JOBS, type AuditKind, type AuditRow } from "./data";
import {
  ANNOUNCEMENTS,
  APP_USAGE,
  CONTRACT_CHECKS,
  DELIVERY_LOG,
  DRIFT_RECENT,
  AUDIT_POLICY,
  DRIFT_UNCONFIRMED,
  FEATURE_FLAGS,
  MIGRATION,
  NOTIFICATION_CATALOGUE,
  SIGNINS_PER_DAY,
} from "./data-platform";
import { pinnedCell, pinnedHead } from "./pinned";
import { useAdmin } from "./store";

/* ---------------------------------------------------------------------------
 * The platform screens that answer a question rather than configure something:
 * what needs doing today, whether the apps are answering, what changed, what
 * the platform sent, and whether the migration is finished.
 * ------------------------------------------------------------------------- */

/* --------------------------------------------------------------- attention */

export function AttentionTab({ navigate }: { navigate: (s: string, t: number) => void }) {
  const { users, requests, expiring, registry, unused, notify } = useAdmin();

  const rows = [
    {
      n: 1, one: "integration failing", many: "integrations failing", detail: "External order system — authentication rejected on the last three attempts.",
      tone: "danger" as const, cta: "Open integrations", go: () => navigate("overview", 2),
    },
    {
      n: JOBS.filter((j) => !j.ok).length, one: "scheduled job failed", many: "scheduled jobs failed",
      detail: "Recompute buying cycles timed out. The queue is ordering on yesterday's projections.",
      tone: "danger" as const, cta: "Open job health", go: () => navigate("overview", 5),
    },
    {
      n: CONTRACT_CHECKS.filter((c) => !c.ok && c.app === "Telecaller CRM").length, one: "app contract failing", many: "app contracts failing",
      detail: "The CRM's per-user summary does not answer, so owned records and offboarding impact read empty.",
      tone: "danger" as const, cta: "Open contract validation", go: () => navigate("apps", 5),
    },
    {
      n: requests.length, one: "access request", many: "access requests", detail: "Raised from the launcher's locked chips.",
      tone: "warn" as const, cta: "Open requests", go: () => navigate("people", 1),
    },
    {
      n: users.filter((u) => u.status === "Locked").length, one: "account locked out", many: "accounts locked out",
      detail: "Locked after failed sign-in attempts. Unlocking changes no password.",
      tone: "warn" as const, cta: "Open lockouts", go: () => navigate("people", 3),
    },
    {
      n: users.filter((u) => u.status === "Invited").length, one: "invited over seven days ago, never signed in", many: "invited over seven days ago, never signed in",
      detail: "An invitation nobody opened means somebody is not working yet and has not said so.",
      tone: "warn" as const, cta: "Open onboarding", go: () => navigate("people", 4),
    },
    {
      n: expiring.filter((e) => e.left <= 30).length, one: "access grant expiring", many: "access grants expiring",
      detail: "Temporary grants that end within the month.",
      tone: "neutral" as const, cta: "Open app access", go: () => navigate("people", 1),
    },
    {
      n: unused.length, one: "granted app never opened", many: "granted apps never opened", detail: "Access sprawl, cleaned up from the unused-access report.",
      tone: "neutral" as const, cta: "Open app access", go: () => navigate("people", 1),
    },
    {
      n: 14, one: "CRM customer unassigned", many: "CRM customers unassigned", detail: "Nobody's book. They will not appear in any queue.",
      tone: "warn" as const, cta: "Open in the CRM", go: () => notify("Opening customer assignment in the CRM"),
    },
    {
      n: registry.filter((a) => a.status === "Maintenance").length, one: "app in maintenance", many: "apps in maintenance",
      detail: "A banner is showing inside the app and on its launcher card.",
      tone: "neutral" as const, cta: "Open app status", go: () => navigate("apps", 1),
    },
  ].filter((r) => r.n > 0);

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Needs an admin today"
        hint="Not everything that is wrong — everything that is somebody's job before this evening."
      />
      {rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">
          Nothing is waiting. Every app is answering, every job ran, and no access is outstanding.
        </div>
      ) : null}
      {rows.map((r, i) => (
        <div
          key={r.one}
          className={cx(
            "flex items-center gap-4 border-l-[3px] px-5 py-3.5",
            i ? "border-t border-t-canvas" : "",
            r.tone === "danger"
              ? "border-l-danger bg-danger-soft"
              : r.tone === "warn"
                ? "border-l-warn bg-warn-soft"
                : "border-l-line-strong bg-surface",
          )}
        >
          <span
            className={cx(
              "min-w-10 text-right text-[22px] font-semibold",
              r.tone === "danger" ? "text-danger" : r.tone === "warn" ? "text-warn-ink" : "text-ink",
            )}
          >
            {r.n}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">{r.n === 1 ? r.one : r.many}</span>
            <span className="block text-[13px] text-muted">{r.detail}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={r.go}>
            {r.cta}
          </Button>
        </div>
      ))}
    </Card>
  );
}

/* ------------------------------------------------------------------- usage */

export function UsageTab() {
  const peak = Math.max(...SIGNINS_PER_DAY);
  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Sign-ins per day"
          hint="Thirty days. Enough to answer “is anyone actually using this?” and nothing more."
        />
        <div className="flex items-end gap-1 px-5 pt-6 pb-3" style={{ height: 140 }}>
          {SIGNINS_PER_DAY.map((n, i) => (
            <span
              key={i}
              title={`${n} sign-in${n === 1 ? "" : "s"}`}
              className={cx("flex-1 rounded-t-[2px]", n === 0 ? "bg-divider" : "bg-brand-softer")}
              style={{ height: `${Math.max(2, (n / peak) * 100)}%` }}
            />
          ))}
        </div>
        <div className="flex justify-between border-t border-divider px-5 py-2 text-[11px] tracking-[0.04em] text-muted uppercase">
          <span>30 days ago</span>
          <span>Gaps are Sundays</span>
          <span>Today</span>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Active users per app" hint="Granted against actually opening it." />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>App</Th>
                <Th align="right">Active</Th>
                <Th align="right">Granted</Th>
                <Th>Take-up</Th>
                <Th>Last activity</Th>
                <Th align="right">Opens this week</Th>
              </tr>
            </thead>
            <tbody>
              {APP_USAGE.map((a, i) => (
                <Tr key={a.app} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{a.app}</Td>
                  <Td align="right">{a.active}</Td>
                  <Td align="right">{a.of}</Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Progress
                        className="w-24"
                        value={a.of ? (a.active / a.of) * 100 : 0}
                        tone={a.of === 0 ? "warn" : a.active === a.of ? "success" : "warn"}
                      />
                      <span className="text-[13px] text-muted">
                        {a.of ? `${Math.round((a.active / a.of) * 100)}%` : "—"}
                      </span>
                    </span>
                  </Td>
                  <Td>{a.lastActive}</Td>
                  <Td align="right">{a.opens}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
          Order Management is granted to one person who has never opened it. That grant appears in the unused-access
          report.
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------ configuration drift */

export function DriftTab({ navigate }: { navigate: (s: string, t: number) => void }) {
  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Changed in the last seven days" hint="Across every app." />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Setting</Th>
                <Th>App</Th>
                <Th>From</Th>
                <Th>To</Th>
                <Th>By</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {DRIFT_RECENT.map((r, i) => (
                <Tr key={r.setting} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{r.setting}</Td>
                  <Td>{r.app}</Td>
                  <Td>{r.from}</Td>
                  <Td>{r.to}</Td>
                  <Td>{r.by}</Td>
                  <Td>{r.t}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Still on a default the business has not confirmed"
          hint="Untouched is not the same as agreed. During rollout this is the list to work down."
          action={
            <Button size="sm" variant="ghost" onClick={() => navigate("crm", 0)}>
              Open CRM configuration
            </Button>
          }
        />
        {DRIFT_UNCONFIRMED.map((r, i) => (
          <div
            key={r.setting}
            className={cx("flex items-start gap-4 px-5 py-3.5", i ? "border-t border-canvas" : "")}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2.5">
                <span className="text-sm font-medium text-ink">{r.setting}</span>
                <Badge tone="warn">Unconfirmed</Badge>
                <span className="text-[13px] text-muted">{r.app}</span>
              </span>
              <span className="mt-0.5 block text-[13px] leading-[19px] text-body">{r.why}</span>
            </span>
            <span className="flex-none text-right">
              <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Current</span>
              <span className="block text-sm font-medium text-ink">{r.value}</span>
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------- per-app dashboard */

export function PerAppDashboard() {
  const { registry, users } = useAdmin();
  const [appId, setAppId] = React.useState(registry[0]?.id ?? "crm");
  const app = registry.find((a) => a.id === appId) ?? registry[0];
  const live = app.status === "Live";
  const flags = FEATURE_FLAGS.filter((f) => f.app === app.name);
  const checks = CONTRACT_CHECKS.filter((c) => c.app === app.name);
  const jobs = JOBS.filter((j) => j.app === app.name);
  const settingCount = app.id === "crm" ? CRM_SCHEMA.tabs.flatMap((t) => t.groups.flatMap((g) => g.fields)).length : 0;

  return (
    <div>
      <div className="mt-5">
        <Select value={appId} onChange={(e) => setAppId(e.target.value)} className="w-[280px]">
          {registry.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="mt-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {[
          { label: "Status", value: app.status, sub: live ? "Reachable, answering" : "Not deployed" },
          { label: "Users with access", value: String(users.filter((u) => u.apps.includes(app.id)).length), sub: `${users.length} accounts on the platform` },
          { label: "Settings declared", value: live ? String(settingCount) : "—", sub: live ? "Rendered from the schema" : "No schema published" },
          { label: "Contract checks", value: `${checks.filter((c) => c.ok).length}/${checks.length || 1}`, sub: checks.every((c) => c.ok) ? "All endpoints answering" : "One endpoint failing" },
        ].map((f) => (
          <Card key={f.label} className="p-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{f.label}</div>
            <div className="mt-1 text-[22px] leading-7 font-semibold text-ink">{f.value}</div>
            <div className="text-[13px] text-muted">{f.sub}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Scheduled jobs" hint="This app's own." />
        {jobs.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">This app declares no scheduled jobs.</div>
        ) : null}
        {jobs.map((j, i) => (
          <div key={j.name} className={cx("flex items-center gap-4 px-5 py-3", i ? "border-t border-canvas" : "")}>
            <span className="min-w-0 flex-1 text-sm text-ink">{j.name}</span>
            <span className="text-[13px] text-muted">{j.last}</span>
            <Badge tone={j.ok ? "success" : "danger"}>{j.ok ? "Ran" : "Failed"}</Badge>
          </div>
        ))}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Modules" hint="What is switched on inside this app right now." />
        {flags.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">This app declares no modules.</div>
        ) : null}
        {flags.map((f, i) => (
          <div key={f.key} className={cx("flex items-center gap-4 px-5 py-3", i ? "border-t border-canvas" : "")}>
            <span className="min-w-0 flex-1 text-sm text-ink">{f.label}</span>
            <Badge tone={f.on ? "success" : "neutral"}>{f.on ? "On" : "Off"}</Badge>
          </div>
        ))}
      </Card>
    </div>
  );
}

/* --------------------------------------------------------- schema inspector */

export function SchemaInspector() {
  const { registry } = useAdmin();
  const [appId, setAppId] = React.useState("crm");
  const app = registry.find((a) => a.id === appId)!;
  const live = app.status === "Live";
  const fields = live ? CRM_SCHEMA.tabs.flatMap((t) => t.groups.flatMap((g) => g.fields.map((f) => ({ tab: t.label, ...f })))) : [];

  return (
    <div>
      <div className="mt-5 flex items-center gap-3">
        <Select value={appId} onChange={(e) => setAppId(e.target.value)} className="w-[280px]">
          {registry.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <span className="font-mono text-[13px] text-muted">{app.schemaEndpoint}</span>
      </div>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Declared schema"
          hint="Exactly what the app is publishing. When a setting does not appear in the console, this is where you find out why."
        />
        {!live ? (
          <div className="px-5 py-8 text-center text-sm text-muted">
            {app.name} publishes no schema yet, so it has no settings section.
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="[&_td]:whitespace-nowrap">
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Sub-tab</Th>
                  <Th>Type</Th>
                  <Th>Default</Th>
                  <Th>Range</Th>
                  <Th>Restricted</Th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f, i) => (
                  <Tr key={f.key} className={i % 2 ? "bg-canvas" : ""}>
                    <Td>
                      <span className="font-mono text-[13px] text-ink">{f.key}</span>
                    </Td>
                    <Td>{f.tab}</Td>
                    <Td>
                      <Badge tone="neutral">{f.type}</Badge>
                    </Td>
                    <Td className="max-w-[280px] truncate">
                      {f.type === "entity"
                        ? `entity · ${f.entity}`
                        : f.def === undefined
                          ? (f.parts ?? f.pairs ?? []).map((p) => p.v).join(" / ")
                          : String(Array.isArray(f.def) ? f.def.join(", ") : f.def)}
                    </Td>
                    <Td>{f.min !== undefined ? `${f.min}–${f.max}` : "—"}</Td>
                    <Td>{f.adminOnly ? <Badge tone="warn">Platform admin</Badge> : "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------ contract validation */

export function ContractValidation() {
  const { notify } = useAdmin();
  const failing = CONTRACT_CHECKS.filter((c) => !c.ok && c.app === "Telecaller CRM");

  return (
    <div>
      {failing.length ? (
        <div className="mt-5 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-4 py-3">
          <div className="text-sm font-medium text-danger">A registered app is not answering one of its contracts</div>
          <div className="mt-1 text-sm leading-[21px] text-ink">
            This is the failure that hides: the app looks registered, the launcher shows a zero, and nobody finds out
            until an offboarding shows no impact for somebody who owns a hundred and forty customers.
          </div>
        </div>
      ) : null}

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Declared endpoints"
          hint="Each contract called for real, not assumed from the registry entry."
          action={
            <Button size="sm" variant="ghost" onClick={() => notify("Re-checking every declared endpoint…")}>
              Re-run every check
            </Button>
          }
        />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>App</Th>
                <Th>Contract</Th>
                <Th>Endpoint</Th>
                <Th>Result</Th>
                <Th align="right">Response</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {CONTRACT_CHECKS.map((c, i) => (
                <Tr key={`${c.app}-${c.label}`} className={c.ok ? (i % 2 ? "bg-canvas" : "") : "bg-danger-soft"}>
                  <Td className="font-medium text-ink">{c.app}</Td>
                  <Td>{c.label}</Td>
                  <Td>
                    <span className="font-mono text-[13px] text-muted">{c.endpoint}</span>
                  </Td>
                  <Td>
                    <Badge tone={c.ok ? "success" : "danger"}>{c.ok ? "Pass" : "Fail"}</Badge>
                  </Td>
                  <Td align="right">{c.ms === null ? "—" : `${c.ms} ms`}</Td>
                  <Td className="max-w-[420px] !whitespace-normal">{c.note}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ feature flags */

export function FeatureFlagsTab() {
  const { registry, notify } = useAdmin();
  const [flags, setFlags] = React.useState(FEATURE_FLAGS);

  return (
    <div>
      {registry
        .filter((a) => flags.some((f) => f.app === a.name))
        .map((a) => (
          <Card key={a.id} className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <CardHeader
              title={a.name}
              hint="Switch a module off and it disappears from the app without a deploy. Useful for a phased rollout — launch with the queue, enable recovery later."
            />
            {flags
              .filter((f) => f.app === a.name)
              .map((f, i) => (
                <div key={f.key} className={cx("flex items-center gap-4 px-5 py-3.5", i ? "border-t border-canvas" : "")}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{f.label}</span>
                    <span className="block text-[13px] text-muted">{f.note}</span>
                  </span>
                  <button
                    aria-pressed={f.on}
                    onClick={() => {
                      setFlags((all) => all.map((x) => (x.key === f.key ? { ...x, on: !x.on } : x)));
                      notify(`${f.label} ${f.on ? "switched off" : "switched on"} in ${a.name}`);
                    }}
                    className={cx(
                      "relative h-[22px] w-[38px] flex-none cursor-pointer rounded-full border-none p-0",
                      f.on ? "bg-brand" : "bg-line",
                    )}
                  >
                    <span
                      className={cx("absolute top-[3px] block h-4 w-4 rounded-full bg-white", f.on ? "left-[19px]" : "left-[3px]")}
                    />
                  </button>
                </div>
              ))}
          </Card>
        ))}
    </div>
  );
}

/* ---------------------------------------------------------- migration status */

export function MigrationStatus() {
  const { notify } = useAdmin();
  const total = MIGRATION.reduce((a, r) => a + r.total, 0);
  const done = MIGRATION.reduce((a, r) => a + r.done, 0);

  return (
    <div>
      <Card className="mt-5 p-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Overall</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-[28px] leading-9 font-semibold text-ink">{Math.round((done / total) * 100)}%</span>
          <span className="text-[13px] text-muted">
            {done.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")} records loaded
          </span>
        </div>
        <Progress className="mt-3" value={(done / total) * 100} />
        <div className="mt-3 text-[13px] text-muted">
          This screen exists for the cutover and is retired afterwards. It is read-only — migration itself is a script,
          not a button.
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="By dataset" />
        {MIGRATION.map((r, i) => {
          const pct = r.total ? (r.done / r.total) * 100 : 0;
          return (
            <div key={r.what} className={cx("px-5 py-3.5", i ? "border-t border-canvas" : "")}>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-sm font-medium text-ink">{r.what}</span>
                <Badge tone={r.failed ? "warn" : pct === 100 ? "success" : pct === 0 ? "neutral" : "warn"}>
                  {pct === 100 && !r.failed ? "Complete" : pct === 0 ? "Not started" : "Exceptions"}
                </Badge>
                <span className="text-[13px] whitespace-nowrap text-muted">
                  {r.done.toLocaleString("en-IN")} / {r.total.toLocaleString("en-IN")}
                </span>
                {r.failed ? (
                  <Button size="sm" variant="ghost" onClick={() => notify("Exception file downloaded")}>
                    {r.failed} exceptions
                  </Button>
                ) : null}
              </div>
              <Progress className="mt-2" value={pct} tone={r.failed ? "warn" : "brand"} />
              <div className="mt-1.5 text-[13px] text-muted">{r.note}</div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------- notifications */

export function NotificationsSection({ tab }: { tab: number }) {
  const { notify, openDrawer } = useAdmin();
  const [catalogue, setCatalogue] = React.useState(NOTIFICATION_CATALOGUE);

  if (tab === 0) {
    return (
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Notification catalogue"
          hint="Every notification any app can send, and who receives it. One place to answer “why did four people get emailed about that?”"
        />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>App</Th>
                <Th>What it is</Th>
                <Th>Telecaller</Th>
                <Th>Manager</Th>
              </tr>
            </thead>
            <tbody>
              {catalogue.map((n, i) => (
                <Tr key={`${n.app}-${n.event}`} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{n.event}</Td>
                  <Td>{n.app}</Td>
                  <Td className="max-w-[360px] !whitespace-normal">{n.desc}</Td>
                  {(["Telecaller", "Manager"] as const).map((role) => (
                    <Td key={role}>
                      <Checkbox
                        label=""
                        aria-label={`${n.event} to ${role}`}
                        checked={n.roles[role]}
                        onChange={() => {
                          setCatalogue((all) =>
                            all.map((x) =>
                              x.event === n.event && x.app === n.app
                                ? { ...x, roles: { ...x.roles, [role]: !x.roles[role] } }
                                : x,
                            ),
                          );
                          notify(`${n.event} ${n.roles[role] ? "no longer sent to" : "now sent to"} ${role}s`);
                        }}
                      />
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  if (tab === 1) {
    return (
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Announcements"
          hint="Shown on the launcher. Everybody passes through it each morning, which is what makes this worth having."
          action={
            <Button size="sm" variant="primary" onClick={() => openDrawer({ kind: "announcement", id: null })}>
              New announcement
            </Button>
          }
        />
        {ANNOUNCEMENTS.map((a, i) => (
          <div
            key={a.id}
            className={cx(
              "flex items-start gap-4 border-l-[3px] px-5 py-3.5",
              i ? "border-t border-t-canvas" : "",
              a.severity === "Warning" ? "border-l-warn bg-warn-soft" : "border-l-brand bg-surface",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2.5">
                <span className="text-sm font-medium text-ink">{a.title}</span>
                <Badge tone={a.severity === "Warning" ? "warn" : "brand"}>{a.severity}</Badge>
                <Badge tone={a.state === "Live" ? "success" : a.state === "Scheduled" ? "brand" : "neutral"}>
                  {a.state}
                </Badge>
              </span>
              <span className="mt-1 block text-[13px] leading-[19px] text-body">{a.body}</span>
              <span className="mt-1 block text-xs text-muted">
                {a.from} → {a.to} · {a.audience}
              </span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => openDrawer({ kind: "announcement", id: a.id })}>
              Edit
            </Button>
          </div>
        ))}
      </Card>
    );
  }

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader title="Delivery log" hint="What was sent, to whom, and whether anybody looked at it." />
      <div className="overflow-auto">
        <table className="[&_td]:whitespace-nowrap">
          <thead>
            <tr>
              <Th>What</Th>
              <Th>To</Th>
              <Th>Channel</Th>
              <Th>When</Th>
              <Th>State</Th>
            </tr>
          </thead>
          <tbody>
            {DELIVERY_LOG.map((r, i) => (
              <Tr key={`${r.what}-${r.to}-${r.t}`} className={i % 2 ? "bg-canvas" : ""}>
                <Td className="font-medium text-ink">{r.what}</Td>
                <Td>{r.to}</Td>
                <Td>{r.channel}</Td>
                <Td>{r.t}</Td>
                <Td>
                  <Badge tone={r.state.startsWith("Seen") ? "success" : r.state === "Not seen" ? "warn" : "neutral"}>
                    {r.state}
                  </Badge>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------- unified audit */

export function UnifiedAudit() {
  const { audit, users, registry } = useAdmin();
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<"all" | AuditKind>("all");
  const [entity, setEntity] = React.useState("Everything");
  const [diff, setDiff] = React.useState<AuditRow | null>(null);

  const entities = ["Everything", ...users.map((u) => u.name), ...registry.map((a) => a.name)];

  const rows = audit.filter((r) => {
    if (kind !== "all" && r.kind !== kind) return false;
    if (entity !== "Everything" && ![r.actor, r.app, r.to, r.from, r.setting].some((v) => v === entity)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return [r.setting, r.app, r.from, r.to, r.actor, r.t].some((v) => v.toLowerCase().includes(q));
  });

  return (
    <div>
      <Card className="mt-5 flex flex-wrap items-end gap-3 p-4 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <label className="block min-w-[280px] flex-1">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Search</span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="A setting, an app, a person, a value"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Kind</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">Everything</option>
            <option value="config">Configuration</option>
            <option value="access">Access</option>
            <option value="admin">Admin actions</option>
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Entity</span>
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-[220px]">
            {entities.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </Select>
        </label>
        <span className="pb-2 text-[13px] text-muted">
          {rows.length} of {audit.length} records
        </span>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Kind</Th>
                <Th>What changed</Th>
                <Th>App</Th>
                <Th>Change</Th>
                <Th>Who</Th>
                <Th>When</Th>
                <Th className={pinnedHead("right")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={`${r.setting}-${r.t}-${i}`} className={i % 2 ? "bg-canvas" : ""}>
                  <Td>
                    <Badge tone={r.kind === "config" ? "brand" : r.kind === "access" ? "warn" : "neutral"}>
                      {r.kind === "config" ? "Config" : r.kind === "access" ? "Access" : "Admin"}
                    </Badge>
                  </Td>
                  <Td className="font-medium text-ink">{r.setting}</Td>
                  <Td>{r.app}</Td>
                  <Td>{r.from === "—" ? r.to : `${r.from} → ${r.to}`}</Td>
                  <Td>{r.actor}</Td>
                  <Td>{r.t}</Td>
                  <Td className={pinnedCell("right", i)}>
                    {r.kind === "config" ? (
                      <Button size="sm" variant="ghost" onClick={() => setDiff(r)}>
                        Diff
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? (
          <div className="px-6 py-10 text-center text-[15px] text-muted">Nothing matches that search.</div>
        ) : null}
        <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
          Read-only. Audit records cannot be edited or deleted by anyone, including a platform admin.
        </div>
      </Card>

      <AuditPolicy />

      <Modal
        open={!!diff}
        onClose={() => setDiff(null)}
        title={diff ? diff.setting : ""}
        width={620}
        footer={
          <Button variant="secondary" onClick={() => setDiff(null)}>
            Close
          </Button>
        }
      >
        {diff ? (
          <div>
            <div className="text-[13px] text-muted">
              {diff.app} · changed by {diff.actor} · {diff.t}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="overflow-hidden rounded-[4px] border border-line">
                <div className="border-b border-divider bg-canvas px-3 py-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Before
                </div>
                <div className="px-3 py-3 font-mono text-[13px] text-body">{diff.from}</div>
              </div>
              <div className="overflow-hidden rounded-[4px] border border-brand-softer">
                <div className="border-b border-brand-softer bg-brand-soft px-3 py-2 text-[11px] font-medium tracking-[0.04em] text-[#5223E0] uppercase">
                  After
                </div>
                <div className="px-3 py-3 font-mono text-[13px] text-ink">{diff.to}</div>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/**
 * Retention is the only setting on this screen, and it is the one place where
 * an audit record can legitimately disappear. It ages out on a schedule, and
 * only after it has been exported — never by anybody's hand.
 */
function AuditPolicy() {
  const { notify, record } = useAdmin();
  const [months, setMonths] = React.useState(String(AUDIT_POLICY.retentionMonths));
  const [exportFirst, setExportFirst] = React.useState(AUDIT_POLICY.exportBeforeAgeOut);
  const [scheduled, setScheduled] = React.useState(AUDIT_POLICY.scheduledExport);
  const [day, setDay] = React.useState(AUDIT_POLICY.scheduleDay);
  const [to, setTo] = React.useState(AUDIT_POLICY.destination);

  const dirty =
    months !== String(AUDIT_POLICY.retentionMonths) ||
    exportFirst !== AUDIT_POLICY.exportBeforeAgeOut ||
    scheduled !== AUDIT_POLICY.scheduledExport ||
    day !== AUDIT_POLICY.scheduleDay ||
    to !== AUDIT_POLICY.destination;

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Retention and export"
        hint="The oldest record here is from 02 Jan 2026. Nothing ages out until it has been written to a file somewhere else."
      />

      <div className="flex items-center gap-4 px-5 py-3.5">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">Keep audit records for</span>
          <span className="block text-[13px] text-muted">
            Oldest record on the platform: {AUDIT_POLICY.oldestRecord}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="block w-[110px]">
            <Input value={months} onChange={(e) => setMonths(e.target.value.replace(/[^0-9]/g, ""))} className="text-right" />
          </span>
          <span className="text-sm text-muted">months</span>
        </span>
      </div>

      <div className="flex items-center gap-4 border-t border-canvas px-5 py-3.5">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">Export before anything ages out</span>
          <span className="block text-[13px] text-muted">
            Off means records are simply dropped, and the history is gone for good.
          </span>
        </span>
        <PolicyToggle on={exportFirst} onToggle={() => setExportFirst((v) => !v)} />
      </div>

      <div className="flex items-center gap-4 border-t border-canvas px-5 py-3.5">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">Weekly export</span>
          <span className="block text-[13px] text-muted">Last export: {AUDIT_POLICY.lastExport}</span>
        </span>
        <Select value={day} onChange={(e) => setDay(e.target.value)} disabled={!scheduled}>
          {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </Select>
        <span className="block w-[220px]">
          <Input value={to} disabled={!scheduled} onChange={(e) => setTo(e.target.value)} />
        </span>
        <PolicyToggle on={scheduled} onToggle={() => setScheduled((v) => !v)} />
      </div>

      <div className="flex items-center gap-3 border-t border-divider bg-canvas px-5 py-3">
        <span className="text-[13px] text-muted">
          {dirty ? "Unsaved changes to the retention policy." : "The policy change is itself audited."}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => notify("Audit log exported")}>
          Export now
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          title={dirty ? undefined : "Nothing to save"}
          onClick={() => {
            record("admin", "Platform", "Audit retention policy", `${AUDIT_POLICY.retentionMonths} months`, `${months} months`);
            notify("Retention policy saved");
          }}
        >
          Save policy
        </Button>
      </div>
    </Card>
  );
}

function PolicyToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      aria-pressed={on}
      onClick={onToggle}
      className={cx(
        "relative h-[22px] w-[38px] flex-none cursor-pointer rounded-full border-none p-0",
        on ? "bg-brand" : "bg-line",
      )}
    >
      <span className={cx("absolute top-[3px] block h-4 w-4 rounded-full bg-white", on ? "left-[19px]" : "left-[3px]")} />
    </button>
  );
}
