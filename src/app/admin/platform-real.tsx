"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Th,
  Td,
  Tr,
  cx,
  type Tone,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { triggerJob } from "@/lib/actions/crm";
import { stamp, shortDate } from "@/lib/format";
import type {
  AppHealth,
  AttentionItem,
  AuditRow,
  DriftRow,
  Fact,
  ImportRow,
  Integration,
  JobRow,
  MigrationRow,
  NotificationRow,
  SessionRow,
  UsageRow,
} from "@/lib/services/admin-platform-service";

/* ---------------------------------------------------------------------------
 * The platform sections, rendered from what the database says.
 *
 * These replaced the fixtures. The shape of the screens is deliberately close
 * to what was there — the design was right; the numbers were invented. Where a
 * question has no answer in the data, the tab is gone rather than filled in,
 * so nothing on this side of the console can be read as a fact that is not one.
 * ------------------------------------------------------------------------- */

export type PlatformData = {
  attention: AttentionItem[];
  health: { facts: Fact[]; apps: AppHealth[] };
  integrations: Integration[];
  usage: {
    facts: UsageRow[];
    perUser: Array<{ name: string; role: string; calls: number; lastSeen: string | null }>;
  };
  drift: { rows: DriftRow[]; warnings: string[] };
  jobs: JobRow[];
  audit: AuditRow[];
  imports: ImportRow[];
  migrations: { applied: MigrationRow[]; pending: number };
  notifications: NotificationRow[];
  sessions: SessionRow[];
  onboarding: Array<{ name: string; email: string; createdAt: string; apps: number }>;
};

/* ------------------------------------------------------------- attention */

export function AttentionTab({
  data,
  navigate,
}: {
  data: PlatformData;
  navigate: (section: string, tab: string) => void;
}) {
  const rows = data.attention;

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Needs an admin today"
        hint="Everything here is a count from the database, and everything at zero is not shown."
      />
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing needs an admin"
          body="No failed jobs, no contradictory settings, no unread reports, and nobody left out of a book. This list fills itself when something changes."
        />
      ) : (
        rows.map((r, i) => {
          const go = r.go;
          return (
          <div
            key={r.one}
            className={cx(
              "flex items-center gap-4 border-l-[3px] px-5 py-3.5",
              i ? "border-t border-divider" : "",
              r.tone === "danger"
                ? "border-l-danger bg-danger-soft"
                : r.tone === "warn"
                  ? "border-l-warn bg-warn-soft"
                  : "border-l-line-strong",
            )}
          >
            <span className="w-10 flex-none text-[22px] leading-7 font-semibold text-ink">
              {r.n}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">
                {r.n === 1 ? r.one : r.many}
              </span>
              <span className="block text-[13px] leading-[18px] text-muted">{r.detail}</span>
            </span>
            {"href" in go ? (
              <Link
                href={go.href}
                className="flex-none rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-body no-underline hover:bg-canvas hover:no-underline"
              >
                {r.cta}
              </Link>
            ) : (
              <button
                onClick={() => navigate(go.section, go.tab)}
                className="flex-none cursor-pointer rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-body hover:bg-canvas"
              >
                {r.cta}
              </button>
            )}
          </div>
          );
        })
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ apps */

export function RegistryTab({ data }: { data: PlatformData }) {
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="The app registry"
        hint="One row per app MahekOne knows about. This list drives the launcher, this console's sidebar and every access check — it is code, not a table, so it cannot be edited here."
      />
      <div className="overflow-auto">
        <table className="[&_td]:whitespace-nowrap">
          <thead>
            <tr>
              <Th>App</Th>
              <Th>Status</Th>
              <Th>Accounts with access</Th>
              <Th>Settings it declares</Th>
            </tr>
          </thead>
          <tbody>
            {data.health.apps.map((a, i) => (
              <Tr key={a.id} className={i % 2 ? "bg-canvas" : ""}>
                <Td className="font-medium text-ink">{a.name}</Td>
                <Td>
                  <Badge tone={a.built ? "success" : "neutral"}>
                    {a.built ? "Live" : "Not built"}
                  </Badge>
                </Td>
                <Td>{a.granted}</Td>
                <Td>{a.settings === null ? "None" : a.settings}</Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- health */

export function HealthTab({ data }: { data: PlatformData }) {
  return (
    <div>
      <div className="mt-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {data.health.facts.map((f) => (
          <Card key={f.label} className="p-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {f.label}
            </div>
            <div className="mt-1 text-[28px] leading-9 font-semibold text-ink">{f.value}</div>
            <div className="text-[13px] text-muted">{f.sub}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Registered apps"
          hint="Who holds each app, and how many settings it publishes."
        />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>App</Th>
                <Th>Status</Th>
                <Th>Accounts with access</Th>
                <Th>Published settings</Th>
              </tr>
            </thead>
            <tbody>
              {data.health.apps.map((a, i) => (
                <Tr key={a.id} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{a.name}</Td>
                  <Td>
                    <Badge tone={a.built ? "success" : "neutral"}>
                      {a.built ? "Live" : "Not built"}
                    </Badge>
                  </Td>
                  <Td>{a.granted}</Td>
                  <Td>{a.settings === null ? "Publishes none" : `${a.settings} settings`}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------- integrations */

export function IntegrationsTab({ data }: { data: PlatformData }) {
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="External connections"
        hint="Whether each one is configured on this deployment, and what the last run said where a run is recorded."
      />
      <div className="overflow-auto">
        <table>
          <thead>
            <tr>
              <Th>Connection</Th>
              <Th>State</Th>
              <Th>Last run</Th>
              <Th>What it means</Th>
            </tr>
          </thead>
          <tbody>
            {data.integrations.map((it, i) => (
              <Tr key={it.name} className={i % 2 ? "bg-canvas" : ""}>
                <Td className="font-medium whitespace-nowrap text-ink">{it.name}</Td>
                <Td>
                  <Badge
                    tone={
                      it.state === "Healthy"
                        ? "success"
                        : it.state === "Failing"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {it.state}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap">{it.last}</Td>
                <Td className="text-muted">{it.note}</Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- usage */

export function UsageTab({ data }: { data: PlatformData }) {
  return (
    <div>
      <div className="mt-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {data.usage.facts.map((f) => (
          <Card key={f.label} className="p-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {f.label}
            </div>
            <div className="mt-1 text-[28px] leading-9 font-semibold text-ink">{f.value}</div>
            <div className="text-[13px] text-muted">{f.sub}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="By account" hint="Calls logged in the last seven days." />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Role</Th>
                <Th>Calls, 7 days</Th>
                <Th>Last signed in</Th>
              </tr>
            </thead>
            <tbody>
              {data.usage.perUser.map((u, i) => (
                <Tr key={u.name} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{u.name}</Td>
                  <Td className="capitalize">{u.role}</Td>
                  <Td>{u.calls}</Td>
                  <Td>{u.lastSeen ? stamp(u.lastSeen) : "Never"}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------- configuration */

export function DriftTab({
  data,
  navigate,
}: {
  data: PlatformData;
  navigate: (section: string, tab: string) => void;
}) {
  const { rows, warnings } = data.drift;

  return (
    <div className="mt-5">
      {warnings.length ? (
        <div className="mb-4 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <div className="text-sm font-medium text-warn-ink">
            {warnings.length === 1
              ? "One setting contradicts another"
              : `${warnings.length} settings contradict each other`}
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            {warnings.map((w) => (
              <div key={w} className="text-sm leading-[21px] text-ink">
                {w}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Settings that no longer match the code's default"
          hint="A database keeps what it was seeded with, so a default that changes in the code reaches nobody. This is the list of differences."
          action={
            <button
              onClick={() => navigate("crm", "")}
              className="cursor-pointer rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-body hover:bg-canvas"
            >
              Open CRM settings
            </button>
          }
        />
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing has drifted"
            body="Every stored setting still matches the default the code ships with."
          />
        ) : (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>Setting</Th>
                  <Th>Group</Th>
                  <Th>In use</Th>
                  <Th>Code default</Th>
                  <Th>Changed</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <Tr key={r.key} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">{r.label}</Td>
                    <Td className="capitalize">{r.category}</Td>
                    <Td className="font-mono text-ink">{r.current}</Td>
                    <Td className="font-mono text-muted">{r.fallback}</Td>
                    <Td className="whitespace-nowrap text-muted">
                      {r.changedAt ? stamp(r.changedAt) : "—"}
                      {r.changedBy ? ` · ${r.changedBy}` : ""}
                    </Td>
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

/* ------------------------------------------------------------------ jobs */

/**
 * The jobs a person runs once, by hand.
 *
 * Everything else on this tab runs on a schedule. These do not: a backfill is
 * a one-off that somebody decides to do, usually straight after the release
 * that made it necessary.
 *
 * It is here rather than left to the CLI because of the rule the sheet import
 * already learned the hard way — on a deploy nobody has shell access to, a
 * terminal is not a fallback, it is the only door and it is locked. A job that
 * can only be run from a laptop is a job that does not get run.
 */
function RunByHand() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function run(job: "backfill-timeline") {
    setBusy(job);
    try {
      const result = await triggerJob(job);
      if (result.ok) {
        /* The count is the answer. "Done" would send somebody to the database
           to find out whether it actually did anything. */
        toast.push(result.data?.ran.join(" · ") ?? result.message ?? "Finished");
        router.refresh();
      } else {
        toast.push(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-5 p-4 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <div className="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted">
        Run once, by hand
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void run("backfill-timeline")}>
          {busy === "backfill-timeline" ? "Projecting…" : "Backfill the customer timeline"}
        </Button>
        <span className="max-w-[520px] text-[13px] leading-[19px] text-muted">
          Projects every telecaller call already recorded into the shared timeline, so a
          salesman opening a customer sees what the desk team was told. Safe to run twice —
          a call already projected is skipped rather than duplicated.
        </span>
      </div>
    </Card>
  );
}

export function JobsTab({ data }: { data: PlatformData }) {
  return (
    <>
    <RunByHand />
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Scheduled work"
        hint="The last run of each job, and how it has gone over the past week. Failures sort to the top."
      />
      {data.jobs.length === 0 ? (
        <EmptyState
          title="No job has run on this database"
          body="Jobs are recorded when they run — from the console, from the CLI, or from a scheduler calling the cron endpoint."
        />
      ) : (
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Last run</Th>
                <Th>Outcome</Th>
                <Th>Records</Th>
                <Th>Past 7 days</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j, i) => (
                <Tr key={j.job} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{j.job}</Td>
                  <Td>{stamp(j.startedAt)}</Td>
                  <Td>
                    <Badge tone={j.ok ? "success" : "danger"}>{j.ok ? "OK" : "Failed"}</Badge>
                  </Td>
                  <Td>{j.records}</Td>
                  <Td>
                    {j.runs} run{j.runs === 1 ? "" : "s"}
                    {j.failures ? `, ${j.failures} failed` : ""}
                  </Td>
                  <Td className="max-w-[420px] truncate whitespace-normal text-muted">
                    {j.detail ?? "—"}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
    </>
  );
}

/* ----------------------------------------------------------------- audit */

const AUDIT_KIND_LABEL: Record<string, string> = {
  config: "Configuration",
  access: "Accounts & access",
  signin: "Sign-in",
  work: "App activity",
};

export function AuditTab({ data, tab }: { data: PlatformData; tab: number }) {
  const kinds = ["all", "config", "access", "signin", "work"] as const;
  const kind = kinds[Math.min(tab, kinds.length - 1)];
  const rows = kind === "all" ? data.audit : data.audit.filter((r) => r.kind === kind);

  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing of this kind has been recorded"
          body="The audit log is written as work happens. Nothing is ever edited or deleted from it, including by a platform admin."
        />
      ) : (
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>What happened</Th>
                <Th>Kind</Th>
                <Th>About</Th>
                <Th>Detail</Th>
                <Th>Who</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={`${r.action}-${r.at}-${i}`} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{r.action}</Td>
                  <Td>{AUDIT_KIND_LABEL[r.kind]}</Td>
                  <Td>{r.entityType}</Td>
                  <Td className="max-w-[380px] truncate whitespace-normal text-muted">
                    {r.detail}
                  </Td>
                  <Td>{r.actor ?? "System"}</Td>
                  <Td>{stamp(r.at)}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
        Read-only. Audit records cannot be edited or deleted by anyone, including a platform
        admin.
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ data */

export function ImportsTab({ data }: { data: PlatformData }) {
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Sheet imports"
        hint="Every sync of every tab. A run that read nothing new is the ordinary case — the sync is hash-driven, so unchanged rows cost a read and no write."
      />
      {data.imports.length === 0 ? (
        <EmptyState
          title="Nothing has been imported yet"
          body="The order, payment, taken-order and party tabs are synced from the Order sheet section or by the jobs."
        />
      ) : (
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Source</Th>
                <Th>Mode</Th>
                <Th>Outcome</Th>
                <Th>Read</Th>
                <Th>New</Th>
                <Th>Changed</Th>
                <Th>Unchanged</Th>
                <Th>Issues</Th>
                <Th>Started</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {data.imports.map((r, i) => (
                <Tr key={`${r.source}-${r.startedAt}`} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{r.source}</Td>
                  <Td>{r.mode}</Td>
                  <Td>
                    <Badge
                      tone={
                        r.status === "ok" ? "success" : r.status === "failed" ? "danger" : "warn"
                      }
                    >
                      {r.status}
                    </Badge>
                  </Td>
                  <Td>{r.read}</Td>
                  <Td>{r.created}</Td>
                  <Td>{r.updated}</Td>
                  <Td className="text-muted">{r.unchanged}</Td>
                  <Td className={r.issues ? "text-danger" : ""}>{r.issues}</Td>
                  <Td>{stamp(r.startedAt)}</Td>
                  <Td>{r.by ?? "System"}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function MigrationsTab({ data }: { data: PlatformData }) {
  const { applied, pending } = data.migrations;
  return (
    <div className="mt-5">
      <Card className="mb-4 p-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Schema
        </div>
        <div className="mt-1 text-[28px] leading-9 font-semibold text-ink">
          {pending === 0 ? "Up to date" : `${pending} behind`}
        </div>
        <div className="text-[13px] text-muted">
          {applied.length
            ? `${applied.length} of the most recent migrations are listed below.`
            : "This database has no migration record."}
          {pending > 0
            ? " A deploy runs the outstanding ones; until then some columns this build expects may not exist."
            : ""}
        </div>
      </Card>

      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Applied migrations" hint="Newest first, from Drizzle's own record." />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Hash</Th>
                <Th>Applied</Th>
              </tr>
            </thead>
            <tbody>
              {applied.map((m, i) => (
                <Tr key={m.tag} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-mono text-ink">{m.tag}</Td>
                  <Td>{stamp(m.appliedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------- notifications */

export function NotificationsTab({ data }: { data: PlatformData }) {
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="What the platform has sent"
        hint="Notifications are in-app and per person. There is no email or push channel, so nothing here can have bounced — only gone unread."
      />
      {data.notifications.length === 0 ? (
        <EmptyState
          title="Nothing has been sent"
          body="Notifications are written when something needs somebody: an order to approve, a payment to confirm, feedback to read."
        />
      ) : (
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Title</Th>
                <Th>Detail</Th>
                <Th>To</Th>
                <Th>Read</Th>
                <Th>Sent</Th>
              </tr>
            </thead>
            <tbody>
              {data.notifications.map((n, i) => (
                <Tr key={`${n.to}-${n.at}-${i}`} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{n.title}</Td>
                  <Td className="max-w-[360px] truncate whitespace-normal text-muted">{n.body}</Td>
                  <Td>{n.to}</Td>
                  <Td>
                    <Badge tone={n.read ? "success" : "warn"}>{n.read ? "Read" : "Unread"}</Badge>
                  </Td>
                  <Td>{stamp(n.at)}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------- sessions & onboarding */

export function SessionsTab({ data }: { data: PlatformData }) {
  return (
    <div className="mt-5">
      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Live sessions"
          hint="One row per session that has not expired. A device and an IP are not shown because neither is stored — a session here is an id, an account and an expiry."
        />
        {data.sessions.length === 0 ? (
          <EmptyState title="Nobody is signed in" body="Every session has expired or been ended." />
        ) : (
          <div className="overflow-auto">
            <table className="[&_td]:whitespace-nowrap">
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th>Role</Th>
                  <Th>Signed in</Th>
                  <Th>Expires</Th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s, i) => (
                  <Tr key={s.id} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">{s.user}</Td>
                    <Td className="capitalize">{s.role}</Td>
                    <Td>{stamp(s.startedAt)}</Td>
                    <Td>{shortDate(s.expiresAt)}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-4 p-5 text-sm leading-[21px] text-body shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          How sign-in works here
        </div>
        Sessions are rows in the database, not signed cookies, so ending one takes effect at once.
        A password reset link is single-use, expires in thirty minutes, and spending one deletes
        every session that account had. There is no lockout counter and no failed-attempt log —
        neither is recorded, so neither is shown.
      </Card>
    </div>
  );
}

export function OnboardingTab({ data }: { data: PlatformData }) {
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader
        title="Accounts that have never been used"
        hint="Created, but never signed in. Usually a password that never reached the person."
      />
      {data.onboarding.length === 0 ? (
        <EmptyState
          title="Everybody has signed in"
          body="Every active account has been used at least once."
        />
      ) : (
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Apps granted</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {data.onboarding.map((u, i) => (
                <Tr key={u.email} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{u.name}</Td>
                  <Td>{u.email}</Td>
                  <Td className={u.apps === 0 ? "text-danger" : ""}>
                    {u.apps === 0 ? "None — cannot start work" : u.apps}
                  </Td>
                  <Td>{stamp(u.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export type { Tone };
