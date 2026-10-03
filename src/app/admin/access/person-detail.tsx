"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { CardGrid } from "@/components/ui/card-grid";
import { APPS } from "@/lib/apps";
import { ADMIN, ADMIN_TABS, type TabsOf } from "@/lib/admin-routes";
import { stamp, stampDate } from "@/lib/format";
import { endSessionsFor, sendPasswordResetFor, setUserActive } from "@/lib/actions/people";
import type { Person } from "@/lib/services/admin-people-service";
import type { SessionRow } from "@/lib/services/admin-platform-service";
import type { AuditFeed } from "@/lib/services/audit-feed-service";
import { AuditEntries } from "../audit/audit-feed";
import { AdminPage } from "../_shell/admin-page";

/* ---------------------------------------------------------------------------
 * One account, in full.
 *
 * This screen used to carry seven tabs, most of them fixtures: an activity
 * feed nobody wrote, a session list of invented devices and IP addresses, an
 * offboarding wizard that reassigned records it had made up, and a notes
 * feature that lived in memory until the page was refreshed.
 *
 * What is left is what the database can answer — who they are, what they can
 * open, what is open right now, and what the audit log says about them — plus
 * the three actions that do something: reset, sign out everywhere, and
 * deactivate. It is a page of its own now, at /admin/access/<id>, so it can be
 * linked to; it was an overlay the console drew over the Access list.
 * ------------------------------------------------------------------------- */

export function PersonDetail({
  person,
  tab,
  sessions,
  audit,
  today,
}: {
  person: Person;
  tab: TabsOf<"person">;
  sessions: SessionRow[];
  audit: AuditFeed;
  /** The business date, read on the server — render must not read the clock. */
  today: string;
}) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);

  async function run(work: Promise<{ ok: boolean; message?: string; error?: string }>) {
    setBusy(true);
    try {
      const result = await work;
      notify(result.ok ? (result.message ?? "Done.") : (result.error ?? "That did not work."));
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const joined = stampDate(person.createdAt);
  const lastSeen = person.lastLoginAt ? stamp(person.lastLoginAt) : "Never";

  return (
    <AdminPage
      title={
        <span className="flex items-center gap-3">
          {person.name}
          <Badge tone={person.active ? "success" : "neutral"}>{person.active ? "Active" : "Deactivated"}</Badge>
        </span>
      }
      subtitle={
        <>
          <Link href={ADMIN.access}>Access</Link>
          <span className="capitalize"> · {person.role}</span>
          {person.email ? ` · ${person.email}` : ""}
          {person.phone ? ` · ${person.phone}` : ""} · joined {joined}
        </>
      }
      actions={
        <>
          <Button
            variant="ghost"
            disabled={busy || !person.active}
            title={!person.active ? "This account cannot sign in at all" : undefined}
            onClick={() => void run(sendPasswordResetFor(person.id))}
          >
            Send a field-app password link
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void run(endSessionsFor(person.id))}>
            End every session
          </Button>
          {person.active ? (
            <Button
              variant="secondary"
              className="border-danger text-danger hover:bg-danger-soft"
              disabled={busy}
              onClick={() => void run(setUserActive(person.id, false))}
            >
              Deactivate
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void run(setUserActive(person.id, true))}>
              Reactivate account
            </Button>
          )}
        </>
      }
      tabs={{ items: ADMIN_TABS.person, active: tab, href: (s) => ADMIN.person(person.id, s as TabsOf<"person">) }}
    >
      {tab === "profile" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="Account"
            hint="Both the email and the work number are sign-ins: office staff know their email and telecallers know their number."
          />
          <Facts
            rows={[
              ["Name", person.name],
              ["Work email", person.email ?? "Not recorded"],
              ["Work number", person.phone ?? "Not recorded"],
              ["Role", person.role],
              ["Reports to", person.reportsToName ?? "Nobody"],
              ["Customers in their book", String(person.customerCount || 0)],
              ["Created", joined],
              ["Last signed in", lastSeen],
            ]}
          />
        </Card>
      ) : null}

      {tab === "apps" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="Apps"
            hint="Read here, changed on the Access screen, which is the one place an app is granted — and the only one that knows how far into an app a grant reaches."
          />
          {APPS.filter((a) => !a.retiredInto).map((a, i) => (
            <div key={a.id} className={cx("flex items-center gap-3 px-5 py-3", i ? "border-t border-canvas" : "")}>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{a.name}</span>
                <span className="block text-[13px] text-muted">{a.description}</span>
              </span>
              {person.apps.includes(a.id) ? <Badge tone="success">Granted</Badge> : <span className="text-[13px] text-muted">—</span>}
            </div>
          ))}
          <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
            {person.apps.length === 0
              ? "No app. MahekOne opens on a launcher that says so plainly rather than a blank screen."
              : person.apps.length === 1
                ? "One app, so they are taken straight into it and never see the launcher."
                : `${person.apps.length} apps, so they land on the launcher and choose.`}
          </div>
        </Card>
      ) : null}

      {tab === "sessions" ? (
        <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <CardHeader
            title="Open sessions"
            hint="A session is a row: an id, an account and an expiry. No device and no IP address are stored, so none is shown."
          />
          {sessions.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted">Nothing open. They are not signed in anywhere.</div>
          ) : (
            sessions.map((s, i) => (
              <div key={s.id} className={cx("px-5 py-3", i ? "border-t border-canvas" : "")}>
                <div className="text-sm text-ink">Signed in {stamp(s.startedAt)}</div>
                <div className="mt-0.5 text-[13px] text-muted">Expires {stamp(s.expiresAt)}</div>
              </div>
            ))
          )}
        </Card>
      ) : null}

      {tab === "audit" ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px] text-muted">
            <span>
              What they did, and what was done to their account
              {audit.total > audit.entries.length
                ? ` — the newest ${audit.size} of ${audit.total.toLocaleString("en-IN")}`
                : ""}
              .
            </span>
            {audit.total ? (
              <Link href={`${ADMIN.audit()}?person=${encodeURIComponent(person.id)}`} className="text-[13px] font-medium">
                See everything they did in the audit log →
              </Link>
            ) : null}
          </div>
          {audit.entries.length === 0 ? (
            <Card className="mt-3 px-5 py-6 text-sm text-muted">Nothing recorded against this account yet.</Card>
          ) : (
            <AuditEntries entries={audit.entries} today={today} />
          )}
        </div>
      ) : null}
    </AdminPage>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <CardGrid min={240} gap="gap-x-8 gap-y-3" className="px-5 py-4">
      {rows.map(([label, value]) => (
        <div key={label}>
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            {label}
          </div>
          <div className="mt-0.5 text-sm text-ink capitalize">{value}</div>
        </div>
      ))}
    </CardGrid>
  );
}
