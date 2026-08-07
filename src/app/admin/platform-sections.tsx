"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Td,
  Th,
  Tr,
  cx,
  type Tone,
} from "@/components/ui/primitives";
import {
  BACKUP_FACTS,
  EXPORTS,
  IMPORTS,
  INTEGRATIONS,
  JOBS,
  PLATFORM_FACTS,
  type AuditKind,
} from "./data";
import { useAdmin } from "./store";

/* ---------------------------------------------------------------------------
 * Overview, Apps, Data and Audit. Each tab answers one question an admin
 * actually arrives with, and nothing on these screens is editable by accident.
 * ------------------------------------------------------------------------- */

export function statusTone(status: string): Tone {
  return status === "Live" || status === "Healthy"
    ? "success"
    : status === "Maintenance" || status === "Failing"
      ? status === "Failing"
        ? "danger"
        : "warn"
      : "neutral";
}

/* ---------------------------------------------------------------- overview */

export function OverviewSection({
  tab,
  navigate,
}: {
  tab: number;
  navigate: (section: string, tab: number) => void;
}) {
  if (tab === 0) return <Health navigate={navigate} />;
  if (tab === 1) return <Integrations />;
  if (tab === 2) return <RecentActivity navigate={navigate} />;
  return <ScheduledJobs />;
}

function Health({ navigate }: { navigate: (section: string, tab: number) => void }) {
  const { users, requests, expiring, registry, notify } = useAdmin();

  const failing = INTEGRATIONS.filter((i) => i.state === "Failing").length;
  const jobsFailed = JOBS.filter((j) => !j.ok).length;

  // Only what actually needs somebody today. A band that always shows eight
  // chips is a band nobody reads.
  const items = [
    { n: failing, label: failing === 1 ? "integration failing" : "integrations failing", tone: "danger" as const, go: () => navigate("overview", 1) },
    { n: jobsFailed, label: jobsFailed === 1 ? "scheduled job failed" : "scheduled jobs failed", tone: "danger" as const, go: () => navigate("overview", 3) },
    { n: requests.length, label: requests.length === 1 ? "access request" : "access requests", tone: "warn" as const, go: () => navigate("people", 1) },
    { n: users.filter((u) => u.status === "Locked").length, label: "accounts locked out", tone: "warn" as const, go: () => navigate("people", 3) },
    { n: users.filter((u) => u.status === "Invited").length, label: "invited, never signed in", tone: "warn" as const, go: () => navigate("people", 4) },
    { n: expiring.length, label: "access grants expiring", tone: "neutral" as const, go: () => navigate("people", 1) },
    { n: registry.filter((a) => a.status === "Maintenance").length, label: "apps in maintenance", tone: "neutral" as const, go: () => navigate("apps", 1) },
  ].filter((x) => x.n > 0);

  return (
    <div>
      {items.length ? (
        <Card className="mt-5 px-5 py-4 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <div className="mb-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Needs an admin today
          </div>
          <div className="flex flex-wrap gap-2">
            {items.map((a) => (
              <button
                key={a.label}
                onClick={a.go}
                className={cx(
                  "inline-flex h-[34px] cursor-pointer items-baseline gap-2 rounded-[4px] border px-3 whitespace-nowrap",
                  a.tone === "danger"
                    ? "border-danger-soft bg-danger-soft"
                    : a.tone === "warn"
                      ? "border-warn-line bg-warn-soft"
                      : "border-line bg-surface hover:bg-canvas",
                )}
              >
                <span
                  className={cx(
                    "text-[15px] font-semibold",
                    a.tone === "danger" ? "text-danger" : a.tone === "warn" ? "text-warn-ink" : "text-ink",
                  )}
                >
                  {a.n}
                </span>
                <span className="text-[13px] text-body">{a.label}</span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="mt-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        {PLATFORM_FACTS.map((p) => (
          <Card key={p.label} className="p-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{p.label}</div>
            <div className="mt-1 text-[28px] leading-9 font-semibold text-ink">{p.value}</div>
            <div className="text-[13px] text-muted">{p.sub}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Registered apps" />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>App</Th>
                <Th>Status</Th>
                <Th>Reachable</Th>
                <Th>Last seen</Th>
                <Th>Published schema</Th>
              </tr>
            </thead>
            <tbody>
              {registry.map((a, i) => (
                <Tr key={a.id} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{a.name}</Td>
                  <Td>
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                  </Td>
                  <Td>{a.status === "Live" ? "Reachable" : "Not deployed"}</Td>
                  <Td>{a.status === "Live" ? "Just now" : "—"}</Td>
                  <Td>{a.status === "Live" ? "10 sub-tabs · 78 settings" : "Not published"}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-3 text-[13px] text-muted">
        <button className="cursor-pointer text-brand hover:underline" onClick={() => notify("Health probe re-run against every registered app")}>
          Re-probe every app
        </button>
      </div>
    </div>
  );
}

function Integrations() {
  const { notify } = useAdmin();
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="External connections"
        hint="First thing on this page deliberately — a manager finding stale data inside an app has found out too late."
      />
      {INTEGRATIONS.map((r, i) => (
        <div
          key={r.name}
          className={cx(
            "flex items-start gap-4 border-l-[3px] px-5 py-3.5",
            i ? "border-t border-t-canvas" : "",
            r.state === "Failing"
              ? "border-l-danger bg-danger-soft"
              : r.state === "Not connected"
                ? "border-l-line-strong bg-surface"
                : "border-l-success bg-surface",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2.5">
              <span className="text-sm font-medium text-ink">{r.name}</span>
              <Badge tone={statusTone(r.state)}>{r.state}</Badge>
              <span className="text-[13px] text-muted">{r.app}</span>
            </span>
            <span className="mt-1 block text-[13px] leading-[19px] text-body">{r.note}</span>
          </span>
          <span className="flex-none text-right">
            <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Last success
            </span>
            <span className="block text-sm font-medium text-ink">{r.last}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => notify(`Retrying ${r.name}…`)}>
            Retry now
          </Button>
        </div>
      ))}
    </Card>
  );
}

function RecentActivity({ navigate }: { navigate: (section: string, tab: number) => void }) {
  const { audit } = useAdmin();
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Recent changes"
        action={
          <Button size="sm" variant="ghost" onClick={() => navigate("audit", 0)}>
            Open the full audit log
          </Button>
        }
      />
      <div className="overflow-auto">
        <table>
          <thead>
            <tr>
              <Th>Kind</Th>
              <Th>What changed</Th>
              <Th>App</Th>
              <Th>Change</Th>
              <Th>Who</Th>
              <Th>When</Th>
            </tr>
          </thead>
          <tbody>
            {audit.slice(0, 8).map((r, i) => (
              <Tr key={`${r.setting}-${r.t}-${i}`} className={i % 2 ? "bg-canvas" : ""}>
                <Td>
                  <Badge tone={r.kind === "config" ? "brand" : r.kind === "access" ? "warn" : "neutral"}>
                    {kindLabel(r.kind)}
                  </Badge>
                </Td>
                <Td className="font-medium text-ink">{r.setting}</Td>
                <Td>{r.app}</Td>
                <Td>{r.from === "—" ? r.to : `${r.from} → ${r.to}`}</Td>
                <Td>{r.actor}</Td>
                <Td>{r.t}</Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ScheduledJobs() {
  const { notify } = useAdmin();
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Scheduled jobs"
        hint="A failed nightly job quietly breaks the app that depends on it. This is the only place it becomes visible."
      />
      {JOBS.map((j, i) => (
        <div
          key={j.name}
          className={cx(
            "flex items-start gap-4 border-l-[3px] px-5 py-3.5",
            i ? "border-t border-t-canvas" : "",
            j.ok ? "border-l-success bg-surface" : "border-l-danger bg-danger-soft",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2.5">
              <span className="text-sm font-medium text-ink">{j.name}</span>
              <Badge tone={j.ok ? "success" : "danger"}>{j.ok ? "Ran" : "Failed"}</Badge>
              <span className="text-[13px] text-muted">{j.app}</span>
            </span>
            <span className="mt-0.5 block text-[13px] text-muted">
              Last run {j.last} · {j.dur} · {j.rows}
            </span>
            {j.note ? (
              <span className="mt-1 block text-[13px] leading-[19px] text-ink">{j.note}</span>
            ) : null}
          </span>
          <Button size="sm" variant="ghost" onClick={() => notify(`Re-running ${j.name}…`)}>
            Run now
          </Button>
        </div>
      ))}
    </Card>
  );
}

/* -------------------------------------------------------------------- apps */

export function AppsSection({ tab }: { tab: number }) {
  const { registry, accessRules, toggleAccessRule, setAppStatus, openDrawer, notify } = useAdmin();

  if (tab === 0) {
    return (
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="App registry"
          hint="Adding an entry gives the console a working settings section with no code change — it reads the schema endpoint."
        />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>App</Th>
                <Th>Status</Th>
                <Th>Route</Th>
                <Th>Schema endpoint</Th>
                <Th>Role vocabulary</Th>
                <Th>Order</Th>
              </tr>
            </thead>
            <tbody>
              {registry.map((a, i) => (
                <Tr
                  key={a.id}
                  onClick={() => openDrawer({ kind: "registerApp", id: a.id })}
                  className={cx("cursor-pointer hover:bg-brand-soft", i % 2 ? "bg-canvas" : "")}
                >
                  <Td className="font-medium text-ink">{a.name}</Td>
                  <Td>
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                  </Td>
                  <Td>{a.route}</Td>
                  <Td>
                    <span className="font-mono text-[13px] text-muted">{a.schemaEndpoint}</span>
                  </Td>
                  <Td>{a.roles.join(" · ")}</Td>
                  <Td>{a.order}</Td>
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
          title="Operational status"
          hint="Maintenance mode shows a banner inside the app and marks its launcher card."
        />
        {registry.map((a, i) => (
          <div key={a.id} className={cx("flex items-center gap-4 px-5 py-3.5", i ? "border-t border-canvas" : "")}>
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="text-sm font-medium text-ink">{a.name}</span>
              <Badge tone={statusTone(a.status)}>{a.status}</Badge>
            </span>
            <span className="flex-none text-[13px] text-muted">Maintenance mode</span>
            <button
              onClick={() => setAppStatus(a.id, a.status === "Maintenance" ? "Live" : "Maintenance")}
              aria-pressed={a.status === "Maintenance"}
              className={cx(
                "relative h-[22px] w-[38px] flex-none cursor-pointer rounded-full border-none p-0",
                a.status === "Maintenance" ? "bg-warn" : "bg-line",
              )}
            >
              <span
                className={cx(
                  "absolute top-[3px] block h-4 w-4 rounded-full bg-white",
                  a.status === "Maintenance" ? "left-[19px]" : "left-[3px]",
                )}
              />
            </button>
            <Button
              size="sm"
              variant="ghost"
              disabled={a.status !== "Live"}
              title={a.status !== "Live" ? "Only a live app has jobs to run" : undefined}
              onClick={() => notify(`Scheduled jobs triggered for ${a.name}`)}
            >
              Run scheduled jobs
            </Button>
          </div>
        ))}
      </Card>
    );
  }

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Default access rules"
        hint="A convenience so new users get sensible access without manual granting — not a policy engine."
      />
      {accessRules.map((r, i) => (
        <div key={r.line} className={cx("flex items-center gap-4 px-5 py-3.5", i ? "border-t border-canvas" : "")}>
          <span className="min-w-0 flex-1 text-sm text-ink">{r.line}</span>
          <button
            onClick={() => toggleAccessRule(i)}
            aria-pressed={r.on}
            className={cx(
              "relative h-[22px] w-[38px] flex-none cursor-pointer rounded-full border-none p-0",
              r.on ? "bg-brand" : "bg-line",
            )}
          >
            <span
              className={cx("absolute top-[3px] block h-4 w-4 rounded-full bg-white", r.on ? "left-[19px]" : "left-[3px]")}
            />
          </button>
        </div>
      ))}
    </Card>
  );
}

/* -------------------------------------------------------------------- data */

export function DataSection({ tab }: { tab: number }) {
  const { notify } = useAdmin();

  if (tab === 0) {
    return (
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Import history" hint="A partial import is worth more than a failed one, so the rows that did not land are downloadable." />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>By</Th>
                <Th>When</Th>
                <Th align="right">Rows</Th>
                <Th align="right">Failed</Th>
                <Th>State</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {IMPORTS.map((r, i) => (
                <Tr key={r.what} className={r.ok ? (i % 2 ? "bg-canvas" : "") : "bg-danger-soft"}>
                  <Td className="font-medium text-ink">{r.what}</Td>
                  <Td>{r.by}</Td>
                  <Td>{r.t}</Td>
                  <Td align="right">{r.rows.toLocaleString("en-IN")}</Td>
                  <Td align="right">{r.failed}</Td>
                  <Td>
                    <Badge tone={r.ok ? "success" : "danger"}>{r.ok ? "Complete" : "Partial"}</Badge>
                  </Td>
                  <Td>
                    <Button size="sm" variant="ghost" disabled={!r.failed} onClick={() => notify("Error file downloaded")}>
                      Error file
                    </Button>
                  </Td>
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
          title="Export log"
          hint="Customer books are commercially sensitive, so who exported one is recorded."
        />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>By</Th>
                <Th>When</Th>
                <Th align="right">Rows</Th>
              </tr>
            </thead>
            <tbody>
              {EXPORTS.map((r, i) => (
                <Tr key={r.what} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{r.what}</Td>
                  <Td>{r.by}</Td>
                  <Td>{r.t}</Td>
                  <Td align="right">{r.rows.toLocaleString("en-IN")}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  return (
    <div className="mt-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
      {BACKUP_FACTS.map((p) => (
        <Card key={p.label} className="p-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{p.label}</div>
          <div className="mt-1 text-[28px] leading-9 font-semibold text-ink">{p.value}</div>
          <div className="text-[13px] text-muted">{p.sub}</div>
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- audit */

export function AuditSection({ tab }: { tab: number }) {
  const { audit } = useAdmin();
  const kind: AuditKind = (["config", "access", "admin"] as const)[Math.min(tab, 2)];
  const rows = audit.filter((r) => r.kind === kind);

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <div className="overflow-auto">
        <table>
          <thead>
            <tr>
              <Th>What changed</Th>
              <Th>App</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>Who</Th>
              <Th>When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Tr key={`${r.setting}-${r.t}-${i}`} className={i % 2 ? "bg-canvas" : ""}>
                <Td className="font-medium text-ink">{r.setting}</Td>
                <Td>{r.app}</Td>
                <Td>{r.from}</Td>
                <Td>{r.to}</Td>
                <Td>{r.actor}</Td>
                <Td>{r.t}</Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? (
        <div className="px-6 py-10 text-center text-[15px] text-muted">
          Nothing of this kind has been recorded yet.
        </div>
      ) : null}
      <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
        Read-only. Audit records cannot be edited or deleted by anyone, including a platform admin.
      </div>
    </Card>
  );
}

function kindLabel(kind: AuditKind) {
  return kind === "config" ? "Config" : kind === "access" ? "Access" : "Admin";
}
