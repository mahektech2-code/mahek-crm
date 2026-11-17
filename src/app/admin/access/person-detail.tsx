"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, cx } from "@/components/ui/primitives";
import { mintImpersonationLink } from "@/lib/actions/impersonation";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { useToast } from "@/components/ui/toast";
import { APPS, webApps } from "@/lib/apps";
import { LEVEL_LABELS } from "@/lib/hat-labels";
import type { AppGrant } from "@/lib/services/access-service";
import { ADMIN, ADMIN_TABS, type TabsOf } from "@/lib/admin-routes";
import { initialsOf, stamp, stampDate } from "@/lib/format";
import { endSessionsFor, sendPasswordResetFor, setUserActive } from "@/lib/actions/people";
import type { Person } from "@/lib/services/admin-people-service";
import type { SessionRow } from "@/lib/services/admin-platform-service";
import type { AuditFeed } from "@/lib/services/audit-feed-service";
import { AuditEntries } from "../audit/audit-feed";
import { Pill, Tabs, btnClass } from "../_shell/kit";
import type { PersonCard } from "@/lib/services/admin-access-view-service";
import type { Piece } from "@/lib/audit-labels";
import { ReportsToEditor, type PickPerson } from "./reports-to-editor";
import { SetElsewhere, appExtras, type ElsewhereLink, type PersonEmployee, type PersonPowers } from "./person-powers";

export type { ElsewhereLink } from "./person-powers";

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
  powers,
  employee,
  people,
  elsewhere,
  tab,
  sessions,
  audit,
  today,
  card,
  clashes,
  windowMinutes,
}: {
  person: Person;
  /**
   * What they hold, app by app, WITH the level and how far into each app the
   * grant reaches — the Access screen's own reading, so the two pages cannot
   * describe one person two ways. `person.apps` alone said only "Granted",
   * which was the one fact about a grant nobody comes here to check.
   */
  grants: AppGrant[];
  /** What they hold inside the apps beyond level and screens — null where the Access list has no row for them. */
  powers: PersonPowers | null;
  /** The HRMS employee row HRMS reads as this account, for the head-by-position powers. */
  employee: PersonEmployee | null;
  /** Every account, for the Reports to picker and the people they manage. */
  people: PickPerson[];
  /** The other places an input to their access is kept. */
  elsewhere: ElsewhereLink[];
  tab: TabsOf<"person">;
  sessions: SessionRow[];
  audit: AuditFeed;
  /** The business date, read on the server — render must not read the clock. */
  today: string;
  /** The side cards' counts: wrong passwords, the handset, the seats held, where codes go. */
  card: PersonCard;
  /** Each hat pair that should not meet, in words — empty where none does. */
  clashes: string[];
  /** The wrong-password window, from the throttle's own setting. */
  windowMinutes: number;
}) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  /* Deactivating asks first, the way the Access list does. It ends every
     session they have open, so a stray click here signs somebody out mid-call
     with nothing on their screen saying why. */
  const [confirmingDeactivate, setConfirmingDeactivate] = React.useState(false);
  /* The reporting line is changed where it is read, not in a form always open under the page. */
  const [editingLine, setEditingLine] = React.useState(false);
  const byApp = new Map(grants.map((g) => [g.app, g]));
  /* "Taken straight into it" is about the BROWSER. The Salesman App is the
     handset and opens no tab, so it is not counted — somebody holding the CRM
     and the handset still lands straight in the CRM. `webApps` is the same
     function the launcher and the redirect read. */
  const webCount = webApps(person.apps).length;
  /* A platform administrator holds every ERP, HRMS and Tasks power without a
     row. The account's own Admin level is given to nobody else (see
     ACCOUNT_LEVEL_HINT), and the Admin Console grant at Admin is the thing
     itself; either says it. */
  const platformAdmin = person.role === "admin" || byApp.get("admin")?.role === "admin";

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

  /* The tab labels are the canvas's; the addresses stay the route's own. */
  const TAB_LABEL: Record<TabsOf<"person">, string> = { profile: "Overview", apps: "Apps & screens", sessions: "Sessions", audit: "Activity" };
  const subline = [employee?.position, card.office].filter(Boolean).join(" · ");
  const history = audit.entries.filter((e) => e.group === "access").slice(0, 4);

  return (
    <div className="flex w-full max-w-[1240px] flex-col gap-5 px-7 pt-6 pb-10 text-[13px] leading-[1.45]">
      <div className="flex flex-wrap items-center gap-4">
        <span
          aria-hidden
          className={cx(
            "flex h-14 w-14 flex-none items-center justify-center rounded-full text-xl font-bold",
            platformAdmin ? "bg-ink text-brand-lime" : "bg-brand-softer text-brand-deep",
          )}
        >
          {initialsOf(person.name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 text-2xl leading-[30px] font-bold tracking-[-0.02em] text-ink">{person.name}</h1>
            <Pill tone={person.active ? "ok" : "muted"}>{person.active ? "Enabled" : "Disabled"}</Pill>
          </div>
          {subline ? <div className="text-[13px] text-muted">{subline}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 print:hidden">
          <Link href={`${ADMIN.access}?manage=${encodeURIComponent(person.id)}`} className={cx(btnClass("primary"), "h-[38px]")}>
            Manage access
          </Link>
          <button
            type="button"
            className={cx(btnClass(), "h-[38px]")}
            disabled={busy || !person.active}
            title={person.active ? "A one-time link that signs in as this person" : "This account cannot sign in"}
            onClick={async () => {
              setBusy(true);
              const r = await mintImpersonationLink(person.id);
              setBusy(false);
              if (r.ok) window.location.assign(r.data.url);
              else notify(r.error);
            }}
          >
            Sign in as
          </button>
          {/* A WEB sign-in reset link, mailed to the work email. An account
              with no email has nowhere for it to go, which the hover says. */}
          <IconBtn
            disabled={busy || !person.active || !person.email}
            label={
              !person.active
                ? "This account cannot sign in at all"
                : !person.email
                  ? "No work email, so there is nowhere to send a link. Generate a password from the Access screen instead."
                  : "Send reset link — a single-use link to their work email, good for 30 minutes"
            }
            onClick={() => void run(sendPasswordResetFor(person.id))}
          >
            <path d="M4 6h16v12H4zM4 7l8 6 8-6" />
          </IconBtn>
          <IconBtn disabled={busy} label="End sessions — signs them out everywhere" onClick={() => void run(endSessionsFor(person.id))}>
            <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
          </IconBtn>
          {person.active ? (
            <button type="button" className={cx(btnClass(), "h-[38px] !text-danger")} disabled={busy} onClick={() => setConfirmingDeactivate(true)}>
              Disable
            </button>
          ) : (
            <button type="button" className={cx(btnClass("primary"), "h-[38px]")} disabled={busy} onClick={() => void run(setUserActive(person.id, true))}>
              Enable
            </button>
          )}
        </div>
      </div>

      <Tabs
        items={ADMIN_TABS.person.map((t) => ({ slug: t.slug, label: TAB_LABEL[t.slug], href: ADMIN.person(person.id, t.slug) }))}
        active={tab}
      />

      {/* The sessions it ends, the phone it shuts out and the book left with
          nobody working it — their name typed to confirm. The apps are kept. */}
      {confirmingDeactivate ? (
        <ImpactDialog
          key={person.id}
          kind="admin-user-disable"
          id={person.id}
          confirmLabel="Disable"
          onClose={() => setConfirmingDeactivate(false)}
          onConfirm={async (confirmation) => {
            const r = await setUserActive(person.id, false, confirmation);
            if (r.ok) {
              notify(r.message ?? "Done.");
              router.refresh();
            }
            return r;
          }}
        />
      ) : null}
      {tab === "profile" ? (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <KCard>
              <KCardHead
                title="Apps"
                actions={
                  clashes.length ? (
                    <>
                      <Pill tone="warn">Hats clash</Pill>
                      <InfoDot text={clashes.join(" ")} />
                    </>
                  ) : null
                }
              />
              {grants.length === 0 ? (
                <div className="px-[18px] py-4 text-muted">No app.</div>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <PTh>App</PTh>
                      <PTh>Level</PTh>
                      <PTh>Screens</PTh>
                      <PTh>WhatsApp</PTh>
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map((g) => {
                      const wa = whatsappLevel(g);
                      return (
                        <tr key={g.app}>
                          <PTd className="font-semibold text-ink">{g.appName}</PTd>
                          <PTd>
                            <Pill tone={g.role === "associate" ? "muted" : "brand"}>
                              {g.app === "admin" && g.role === "admin" ? "Platform admin" : LEVEL_LABELS[g.role]}
                            </Pill>
                          </PTd>
                          <PTd>
                            <span className="flex flex-wrap items-center gap-2.5">
                              <span className="tabular-nums">{g.grantedCount >= g.totalCount ? "All" : `${g.grantedCount} / ${g.totalCount}`}</span>
                              <span className="h-1.5 w-[90px] overflow-hidden rounded-[3px] bg-divider">
                                <span className="block h-full bg-brand" style={{ width: `${(g.grantedCount / Math.max(1, g.totalCount)) * 100}%` }} />
                              </span>
                              {g.newScreens.length ? (
                                <Pill tone="warn" title={`Shipped after this grant was saved: ${g.newScreens.map((n) => n.label).join(", ")}`}>
                                  {g.newScreens.length} new
                                </Pill>
                              ) : null}
                            </span>
                          </PTd>
                          <PTd className={wa ? "text-body" : "text-muted"}>{wa ?? "—"}</PTd>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </KCard>
            <KCard>
              <KCardHead title="Details" actions={<InfoDot text={ACCOUNT_LEVEL_HINT} />} />
              <div className="grid grid-cols-1 gap-x-6 gap-y-[18px] p-[18px] sm:grid-cols-2">
                <KV label="Work email" value={person.email ?? "Not recorded"} />
                <KV label="Work number" value={person.phone ?? "Not recorded"} />
                <KV label="Employee code" value={employee?.code ?? "Not in HRMS"} />
                <KV
                  label="Reports to"
                  value={
                    <span className="flex flex-wrap items-center gap-2">
                      {person.reportsToId ? (
                        <Link href={ADMIN.person(person.reportsToId)}>{person.reportsToName ?? "Somebody"}</Link>
                      ) : (
                        "Nobody"
                      )}
                      <button type="button" className="cursor-pointer text-xs font-semibold text-brand hover:underline" onClick={() => setEditingLine((v) => !v)}>
                        {editingLine ? "Close" : "Change"}
                      </button>
                    </span>
                  }
                />
                <KV
                  label="OTP goes to"
                  value={
                    card.otpLast4 ? (
                      <span className="flex items-center gap-1.5">
                        ····· ·{card.otpLast4}
                        <InfoDot text="Their personal mobile in HRMS. Every sign-in, password and reset code goes there." />
                      </span>
                    ) : (
                      <span className="text-muted">{employee ? "No personal mobile in HRMS" : "Not linked to HRMS"}</span>
                    )
                  }
                />
                <KV label="Account created" value={joined} />
              </div>
            </KCard>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <KCard>
              <KCardHead title="Sign-in" />
              <div className="grid grid-cols-1 gap-y-[18px] p-[18px]">
                <KV label="Last signed in" value={lastSeen} />
                <KV label="Live sessions" value={String(sessions.length)} />
                <KV label={`Wrong passwords (${windowMinutes} min)`} value={String(card.wrongPasswords)} />
                <KV label="Handset" value={card.handset ?? "None"} />
              </div>
            </KCard>
            <KCard>
              <KCardHead title="Seats held" actions={<InfoDot text="Disabling a sign-in does not move these." />} />
              {(
                [
                  ["Sales accounts", card.salesBook],
                  ["Back office accounts", card.backOffice],
                  ["Open leads", card.openLeads],
                  ["Open tasks", card.openTasks],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="flex items-center gap-3 border-b border-divider px-[18px] py-[13px] last:border-b-0">
                  <span className="flex-1 text-body">{label}</span>
                  <span className="text-[15px] font-bold text-ink tabular-nums">{n.toLocaleString("en-IN")}</span>
                </div>
              ))}
            </KCard>
            <KCard>
              <KCardHead
                title="Access history"
                actions={
                  audit.total ? (
                    <Link href={ADMIN.person(person.id, "audit")} className="text-[13px] font-semibold">
                      All
                    </Link>
                  ) : null
                }
              />
              {history.length === 0 ? (
                <div className="px-[18px] py-4 text-muted">No change to their access recorded yet.</div>
              ) : (
                history.map((e) => (
                  <div key={e.id} className="border-b border-divider px-[18px] py-[13px] last:border-b-0">
                    <div className="font-semibold text-ink first-letter:uppercase">{e.says.map(pieceText).join("")}</div>
                    <div className="text-muted">
                      {stampDate(e.at)} · {e.actor?.name ?? "MahekOne"}
                    </div>
                  </div>
                ))
              )}
            </KCard>
          </div>
        </div>
      ) : null}
      {tab === "profile" && editingLine ? (
        /* Keyed on the stored line, so a save remounts it from what was
           written rather than resetting its state in an effect. */
        <ReportsToEditor
          key={person.reportsToId ?? "none"}
          userId={person.id}
          name={person.name}
          current={person.reportsToId}
          people={people}
        />
      ) : null}

      {tab === "apps" ? (
        <KCard>
          <KCardHead
            title="Apps"
            actions={<InfoDot text="Read here, changed on the Access screen, which is the one place an app is granted. The level on each app is what they may do in it; the screens are how far into it they reach." />}
          />
          {/* A retired app is listed only while somebody still holds it, so
              the grant that needs taking away is visible rather than hidden. */}
          {APPS.filter((a) => !a.retiredInto || byApp.has(a.id)).map((a, i) => {
            const g = byApp.get(a.id);
            const extras = appExtras({ app: a.id, grant: g ?? null, powers, employee, platformAdmin });
            return (
              <div key={a.id} className={cx("flex items-start gap-3 px-5 py-3", i ? "border-t border-canvas" : "")}>
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {a.name}
                    {a.retiredInto ? <span className="ml-2 text-[12px] font-normal text-warn-ink">retired</span> : null}
                  </span>
                  <span className="block text-[13px] text-muted">{a.description}</span>
                  {extras ? <div>{extras}</div> : null}
                </div>
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
        </KCard>
      ) : null}
      {tab === "apps" ? <SetElsewhere links={elsewhere} /> : null}

      {tab === "sessions" ? (
        <KCard>
          <KCardHead
            title="Open sessions"
            actions={<InfoDot text="A session is a row: an id, an account and an expiry. No device and no IP address are stored, so none is shown." />}
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
        </KCard>
      ) : null}

      {tab === "audit" ? (
        <div className="flex flex-col gap-3">
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
            <KCard>
              <div className="px-[18px] py-4 text-muted">Nothing recorded against this account yet.</div>
            </KCard>
          ) : (
            <AuditEntries entries={audit.entries} today={today} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The canvas's card: white, 8px, a hairline. */
function KCard({ children }: { children: React.ReactNode }) {
  return <section className="min-w-0 overflow-hidden rounded-card border border-line bg-surface">{children}</section>;
}

function KCardHead({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-divider px-[18px] py-3.5">
      <h2 className="m-0 text-base font-bold text-ink">{title}</h2>
      <span className="flex-1" />
      {actions}
    </div>
  );
}

function PTh({ children }: { children: React.ReactNode }) {
  return <th className="bg-ink px-[18px] py-2.5 text-left text-xs font-semibold whitespace-nowrap text-white normal-case">{children}</th>;
}

function PTd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cx("border-b border-divider px-[18px] py-3 align-middle [tr:last-child_&]:border-b-0", className)}>{children}</td>;
}

/** A label over its value. NOT capitalised: an email must read as it is typed. */
function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px]">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <span className="text-sm font-medium break-words text-ink">{value}</span>
    </div>
  );
}

/** The round ⓘ: the explanation is on hover, never on the page. */
function InfoDot({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      className="inline-flex h-5 w-5 flex-none cursor-help items-center justify-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted"
    >
      i
    </span>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-control border border-line-strong bg-surface text-ink hover:bg-[#f7f9fc] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

/** Read or Write on the app's WhatsApp screen; null where the app has none or it is not held. */
function whatsappLevel(g: AppGrant): string | null {
  const read = g.modules.find((m) => m.key.endsWith(".whatsapp"));
  if (!read || !read.granted) return null;
  const write = g.modules.find((m) => m.key.endsWith(".whatsapp-reply"));
  return write?.granted ? "Write" : "Read";
}

function pieceText(p: Piece): string {
  return typeof p === "string" ? p : "strong" in p ? p.strong : p.name;
}
