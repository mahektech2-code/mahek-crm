"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, cx } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { CardGrid } from "@/components/ui/card-grid";
import { APPS, webApps } from "@/lib/apps";
import { LEVEL_LABELS } from "@/lib/hat-labels";
import type { AppGrant } from "@/lib/services/access-service";
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

/** The hover on "Account level", said once and read in two places. */
const ACCOUNT_LEVEL_HINT =
  "Derived from the levels on each app, never set on its own: Admin only for a platform administrator (Admin on the Admin Console), Manager for anybody who manages or administers any app, otherwise Associate. What they may do in an app is the level on that app.";

export function PersonDetail({
  person,
  grants,
  tab,
  sessions,
  audit,
  today,
}: {
  person: Person;
  /**
   * What they hold, app by app, WITH the level and how far into each app the
   * grant reaches — the Access screen's own reading, so the two pages cannot
   * describe one person two ways. `person.apps` alone said only "Granted",
   * which was the one fact about a grant nobody comes here to check.
   */
  grants: AppGrant[];
  tab: TabsOf<"person">;
  sessions: SessionRow[];
  audit: AuditFeed;
  /** The business date, read on the server — render must not read the clock. */
  today: string;
}) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  /* Deactivating asks first, the way the Access list does. It ends every
     session they have open, so a stray click here signs somebody out mid-call
     with nothing on their screen saying why. */
  const [confirmingDeactivate, setConfirmingDeactivate] = React.useState(false);
  const byApp = new Map(grants.map((g) => [g.app, g]));
  /* "Taken straight into it" is about the BROWSER. The Salesman App is the
     handset and opens no tab, so it is not counted — somebody holding the CRM
     and the handset still lands straight in the CRM. `webApps` is the same
     function the launcher and the redirect read. */
  const webCount = webApps(person.apps).length;

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
          <span title={ACCOUNT_LEVEL_HINT}> · {LEVEL_LABELS[person.role] ?? person.role}</span>
          {person.email ? ` · ${person.email}` : ""}
          {person.phone ? ` · ${person.phone}` : ""} · joined {joined}
        </>
      }
      actions={
        <>
          {/* A WEB sign-in reset link, mailed to the work email. It used to be
              labelled a "field-app password link", which it never was: it
              opens /login/reset in a browser, and an account with no email has
              nowhere for it to go — which the button now says rather than
              pretending to send. */}
          <Button
            variant="ghost"
            disabled={busy || !person.active || !person.email}
            title={
              !person.active
                ? "This account cannot sign in at all"
                : !person.email
                  ? "This account has no work email, so there is nowhere to send a link. Generate a password to read out from the Access screen instead."
                  : "Mails a single-use link to their work email to choose a new password. It expires in 30 minutes."
            }
            onClick={() => void run(sendPasswordResetFor(person.id))}
          >
            Email a password-reset link
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void run(endSessionsFor(person.id))}>
            End every session
          </Button>
          {person.active ? (
            <Button
              variant="secondary"
              className="border-danger text-danger hover:bg-danger-soft"
              disabled={busy}
              onClick={() => setConfirmingDeactivate(true)}
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
      <ConfirmDialog
        open={confirmingDeactivate}
        title="Disable this sign-in"
        destructive
        confirmLabel="Disable"
        body={
          <>
            {person.name} will not be able to sign in with their email or their work number,
            and any session they have open stops working. Nothing is deleted — their calls,
            orders and customers stay exactly where they are.
            <p className="mt-2">
              {person.apps.length
                ? "The apps they hold are kept, so enabling them again restores what they had. To take an app away instead, use Manage access on the Access screen."
                : "They hold no app, so there is nothing to keep."}
            </p>
          </>
        }
        onConfirm={() => run(setUserActive(person.id, false))}
        onClose={() => setConfirmingDeactivate(false)}
      />
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
              ["Account level", LEVEL_LABELS[person.role] ?? person.role],
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
            hint="Read here, changed on the Access screen, which is the one place an app is granted. The level on each app is what they may do in it; the screens are how far into it they reach."
          />
          {/* A retired app is listed only while somebody still holds it, so
              the grant that needs taking away is visible rather than hidden. */}
          {APPS.filter((a) => !a.retiredInto || byApp.has(a.id)).map((a, i) => {
            const g = byApp.get(a.id);
            return (
              <div key={a.id} className={cx("flex items-center gap-3 px-5 py-3", i ? "border-t border-canvas" : "")}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {a.name}
                    {a.retiredInto ? <span className="ml-2 text-[12px] font-normal text-warn-ink">retired</span> : null}
                  </span>
                  <span className="block text-[13px] text-muted">{a.description}</span>
                </span>
                {g ? (
                  <span className="flex flex-none items-center gap-2">
                    <span className="text-[13px] text-body">
                      {a.id === "admin" && g.role === "admin" ? "Platform administrator" : LEVEL_LABELS[g.role]}
                    </span>
                    {g.grantedCount >= g.totalCount ? (
                      <span className="text-[13px] text-muted">
                        {g.totalCount === 1 ? "its one screen" : `all ${g.totalCount} screens`}
                      </span>
                    ) : (
                      <Badge tone="warn" title={`${g.grantedCount} of ${g.totalCount} screens — narrowed on the Access screen`}>
                        Narrowed · {g.grantedCount}/{g.totalCount}
                      </Badge>
                    )}
                    {g.readOnly.map((label) => (
                      <Badge key={label} tone="warn" title="Reads the chats; cannot reply or send">
                        {label} read only
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-[13px] text-muted">—</span>
                )}
              </div>
            );
          })}
          <div className="bg-canvas px-5 py-2.5 text-[13px] text-muted">
            {person.apps.length === 0
              ? "No app. MahekOne opens on a launcher that says so plainly rather than a blank screen."
              : webCount === 0
                ? "Only the handset, so the browser has nothing for them — they sign in on MBOS."
                : webCount === 1
                  ? "One app in the browser, so they are taken straight into it and never see the launcher."
                  : `${webCount} apps in the browser, so they land on the launcher and choose.`}
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
          {/* NOT capitalised. It used to be, so an email read "Priya@mahek.in" —
              a different string from the one they sign in with. The values
              that need a capital already carry one. */}
          <div className="mt-0.5 text-sm text-ink">{value}</div>
        </div>
      ))}
    </CardGrid>
  );
}
