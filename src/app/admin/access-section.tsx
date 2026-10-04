"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { FilterPills, Modal, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { grantableApps, isAlwaysOpen, moduleGroupsForApp, modulesForApp } from "@/lib/modules";
import { levelCarries } from "@/lib/capability-labels";
import { LEVEL_LABELS } from "@/lib/hat-labels";
import { getApp, type AppId } from "@/lib/apps";
import { ERP_POWERS, ERP_POWER_LABEL } from "@/lib/erp/powers";
import { HRMS_POWERS, HRMS_POWER_LABEL } from "@/lib/hrms/powers";
import {
  candidatesForGrant,
  employeesToLink,
  issueCredential,
  linkEmployee,
  setAccess,
  type IssuedCredential,
} from "@/lib/actions/access";
import {
  endSessionsFor,
  sendPasswordResetFor,
  setUserActive,
} from "@/lib/actions/people";
import { mintImpersonationLink } from "@/lib/actions/impersonation";
import type {
  AccessRow,
  Candidate,
  LinkableEmployee,
} from "@/lib/services/access-service";
import Link from "next/link";
import { ADMIN } from "@/lib/admin-routes";

/* ---------------------------------------------------------------------------
 * The Access screen.
 *
 * One question, asked in one place: who can open what, and how far into it.
 *
 * It replaced five tabs that each held a piece of the answer — a roster, a
 * grid of app checkboxes, a roles table, a session list — and none of which
 * could grant anything to somebody who did not already have an account. The
 * people who work here are in HRMS, so this starts there.
 *
 * ONE DIALOG PER PERSON, and it holds every app at once. Granting an app,
 * narrowing one and taking one away are the same act — somebody deciding what
 * this person's MahekOne looks like — and doing them one app at a time meant
 * opening the same dialog four times to set up one telecaller, with no screen
 * ever showing the whole answer. The middle page IS the whole answer, and the
 * page after it is the review: what changes, in words, before anything is
 * written.
 *
 * The modules of an app arrive fully ticked. That is not a default so much as
 * a statement of what granting an app has always meant, and the unticking is
 * the new part.
 * ------------------------------------------------------------------------- */

const APPS = grantableApps();

import { conflictsFor } from "@/lib/role-conflicts";

/*
 * THE SAME THREE IN EVERY APP.
 *
 * This list used to carry `Telecaller` and `Accounts` beside `Manager` and
 * `Admin` — two job titles from two particular apps in a list of seniority
 * levels — so granting the Salesman App asked which kind of telecaller a
 * field salesman was. What the app is, the row already says; this only has to
 * say how senior they are in it.
 */
const ROLES = [
  { id: "associate", label: "Associate" },
  { id: "manager", label: "Manager" },
  { id: "admin", label: "Admin" },
] as const;

type RoleId = (typeof ROLES)[number]["id"];

/**
 * What the Admin option is CALLED, which depends on the app it sits beside.
 *
 * "Admin" alone read the same on every row, and it stopped meaning the same
 * thing the day `can()` began reading an admin hat against its own app: Admin
 * on HRMS is HRMS's administrator and nothing more, while Admin on the Admin
 * Console is the platform administrator, who holds everything everywhere. Two
 * very different grants behind one identical word is exactly how somebody
 * hands out the platform while meaning to hand out a desk.
 */
function levelOptionLabel(level: RoleId, app: AppId, appName: string): string {
  if (level !== "admin") return ROLES.find((r) => r.id === level)?.label ?? level;
  return app === "admin" ? "Admin — the whole platform" : `Admin — everything in ${appName}`;
}

/** Every module of an app that its holders reach whatever is ticked. */
const ALWAYS_OF = (app: AppId) => modulesForApp(app).filter((m) => isAlwaysOpen(m.key)).map((m) => m.key);

const VIEWS = [
  "Everyone with access",
  "Narrowed access",
  "No app at all",
  "Disabled",
] as const;
type View = (typeof VIEWS)[number];

/** The desired state while the dialog is open: app → the modules ticked. */
type Draft = Record<string, string[]>;

const ALL_OF = (app: AppId) => modulesForApp(app).map((m) => m.key);

/** What ticking an app (or starting a new grant) selects: every module except the ones that are handed out deliberately. */
const DEFAULT_OF = (app: AppId) => modulesForApp(app).filter((m) => !m.offByDefault).map((m) => m.key);

export function AccessSection({
  rows: allRows,
  isPlatformAdmin,
  enabling,
  onEnablingDone,
  onlyApp,
}: {
  rows: AccessRow[];
  /**
   * Whether the viewer is a PLATFORM ADMINISTRATOR — Admin on the Admin
   * Console. Every action this screen offers refuses anybody else on the
   * server (`requirePlatformAdminUser`), and the page itself is gated the same
   * way, so this is belt and braces: if the page gate is ever loosened, what
   * appears is a read-only list rather than a page of buttons that all fail.
   */
  isPlatformAdmin: boolean;
  /** The page's Enable access button was pressed: the picker comes first. */
  enabling: boolean;
  onEnablingDone: () => void;
  /** Narrowed to the people holding one app — the Home page's apps table links here. */
  onlyApp: AppId | null;
}) {
  const router = useRouter();
  const { push } = useToast();
  const onOpenUser = (id: string) => router.push(ADMIN.person(id));
  const rows = onlyApp ? allRows.filter((r) => r.grants.some((g) => g.app === onlyApp)) : allRows;
  const [view, setView] = React.useState<View>("Everyone with access");
  /** Managing somebody already on the list skips the picker. */
  const [managing, setManaging] = React.useState<AccessRow | null>(null);
  /** Turning the sign-in itself off, or back on. */
  const [switching, setSwitching] = React.useState<AccessRow | null>(null);
  /** Saying which HRMS row this account is — see `EmployeeLinkDialog`. */
  const [linking, setLinking] = React.useState<AccessRow | null>(null);
  /* THE SECOND DOOR ONTO A PASSWORD. The grant flow offers one at the moment
     an account is set up, which is the moment most of them are needed — but
     somebody set up in March who cannot get in today is not going to be given
     access again to reach it. */
  const [crediting, setCrediting] = React.useState<AccessRow | null>(null);
  /** A just-minted sign-in link, shown once so it can be copied. */
  const [linkFor, setLinkFor] = React.useState<{
    name: string;
    url: string;
    expiresInMinutes: number;
  } | null>(null);

  const say = (r: { ok: boolean; message?: string; error?: string }) => {
    push(r.ok ? (r.message ?? "Saved.") : (r.error ?? "That did not work."));
    if (r.ok) router.refresh();
  };

  const inView = rows.filter((r) => {
    if (view === "Disabled") return !r.active;
    if (!r.active) return false;
    if (view === "No app at all") return r.grants.length === 0;
    if (view === "Narrowed access") return r.grants.some((g) => !g.whole);
    return r.grants.length > 0;
  });

  const withAccess = rows.filter((r) => r.active && r.grants.length > 0).length;
  const narrowed = rows.filter((r) => r.grants.some((g) => !g.whole)).length;
  const disabled = rows.filter((r) => !r.active).length;

  return (
    <div>
      {onlyApp ? (
        <div className="mt-5 flex items-center gap-2 text-[13px] text-body">
          <span>
            Showing the people who hold <span className="font-medium text-ink">{getApp(onlyApp)?.name ?? onlyApp}</span>.
          </span>
          <Link href={ADMIN.access}>Show everyone</Link>
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <FilterPills
          options={VIEWS.map((v) => ({ key: v, label: v }))}
          value={view}
          onChange={setView}
        />
        <span className="flex-1" />
        <span className="text-[13px] whitespace-nowrap text-muted">
          {withAccess} with access · {narrowed} narrowed
          {disabled ? ` · ${disabled} disabled` : ""}
        </span>
      </div>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Who opens what"
          hint="Every app a person holds, and how far into each one it reaches. Manage access opens all of it on one page — an app is granted by ticking it and taken away by unticking it, reviewed before anything is written."
        />
        {inView.length === 0 ? (
          <EmptyState
            title={
              view === "Narrowed access"
                ? "Nobody has been narrowed yet"
                : view === "No app at all"
                  ? "Everybody has at least one app"
                  : view === "Disabled"
                    ? "Every account can sign in"
                    : "Nobody here"
            }
            body={
              view === "Narrowed access"
                ? "Every grant is the whole app. Manage somebody's access to withhold a screen."
                : view === "Disabled"
                  ? "Disabling a sign-in keeps the apps it holds, so it is the way to stop somebody signing in without deciding anything about their access."
                  : "Nothing matches this view."
            }
          />
        ) : (
          <div className="overflow-auto">
            <table className="[&_td]:whitespace-nowrap">
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Sign-in</Th>
                  <Th>
                    <span title="Derived from the levels below — Admin only for a platform administrator, Manager for anybody who manages or administers any app, otherwise Associate. It is never set on its own.">
                      Account level
                    </span>
                  </Th>
                  <Th>Employee</Th>
                  <Th>Apps</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {inView.map((r, i) => (
                  <Tr key={r.userId} className={i % 2 ? "bg-canvas" : ""}>
                    <PersonCells row={r} onOpen={() => onOpenUser(r.userId)} />
                    <Td>
                      {r.grants.length === 0 ? (
                        <span className="text-muted">
                          {r.active
                            ? "No app — they can sign in and the launcher says so."
                            : "No app."}
                        </span>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          {r.grants.map((g) => (
                            <span key={g.app} className="inline-flex items-center gap-2">
                              <span className="min-w-[9rem] font-medium text-ink">
                                {g.appName}
                              </span>
                              <span className="text-muted">
                                {g.grantedCount >= g.totalCount
                                  ? g.totalCount === 1
                                    ? "its one screen"
                                    : `all ${g.totalCount} screens`
                                  : `${g.grantedCount} of ${g.totalCount} screens`}
                              </span>
                              {g.grantedCount < g.totalCount ? <Badge tone="warn">Narrowed</Badge> : null}
                              {g.readOnly.map((label) => (
                                <Badge key={label} tone="warn">
                                  {label} read only
                                </Badge>
                              ))}
                            </span>
                          ))}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {isPlatformAdmin ? (
                      <span className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!r.active}
                          // A disabled control always says why.
                          title={
                            r.active
                              ? undefined
                              : "This account cannot sign in. Enable it before changing what it opens."
                          }
                          onClick={() => setManaging(r)}
                        >
                          Manage access
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setSwitching(r)}
                        >
                          {r.active ? "Disable" : "Enable"}
                        </Button>
                        <PersonMenu
                          row={r}
                          say={say}
                          onManage={() => setManaging(r)}
                          onSwitch={() => setSwitching(r)}
                          onOpen={() => onOpenUser(r.userId)}
                          onLinkEmployee={() => setLinking(r)}
                          onCredential={() => setCrediting(r)}
                          onGotLink={setLinkFor}
                        />
                      </span>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Enabling access for somebody new: the picker comes first. */}
      {enabling && isPlatformAdmin ? (
        <AccessDialog
          rows={allRows}
          onClose={onEnablingDone}
          onDone={(r) => {
            say(r);
            onEnablingDone();
          }}
          /* Saved, and the dialog stays up to offer a password. The toast
             fires either way, so the list behind it is already right. */
          onSaved={say}
        />
      ) : null}

      {/*
        Turning the sign-in off, and back on.

        Disabling is not revoking: the apps are kept, so a month's leave is one
        click each way and comes back to the book they left. Which is exactly
        why it is worth saying on the dialog — "disabled" and "has no apps" look
        identical from the outside and mean completely different things.
      */}
      <Modal
        open={!!switching}
        onClose={() => setSwitching(null)}
        title={switching?.active ? "Disable this sign-in" : "Enable this sign-in"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSwitching(null)}>
              Cancel
            </Button>
            <Button
              variant={switching?.active ? "danger" : "primary"}
              onClick={() => {
                if (!switching) return;
                const { userId, active } = switching;
                setSwitching(null);
                void setUserActive(userId, !active).then(say);
              }}
            >
              {switching?.active ? "Disable" : "Enable"}
            </Button>
          </>
        }
      >
        {switching ? (
          <div className="text-sm leading-[21px] text-body">
            {switching.active ? (
              <>
                {switching.name} will not be able to sign in with their email or their work
                number, and any session they have open stops working. Nothing is deleted —
                their calls, orders and customers stay exactly where they are.
                <p className="mt-2">
                  {switching.grants.length
                    ? `${
                        switching.grants.length === 1
                          ? "The one app they hold is kept"
                          : `All ${switching.grants.length} apps they hold are kept`
                      }, so enabling them again restores what they had. To take an app away instead, use Manage access.`
                    : "They hold no app, so there is nothing to keep."}
                </p>
              </>
            ) : (
              <>
                {switching.name} will be able to sign in again, with the password they
                already have.
                <p className="mt-2">
                  {switching.grants.length
                    ? `They open what they opened before — ${switching.grants.map((g) => g.appName).join(", ")}.`
                    : "They hold no app, so they land on a launcher that says so. Give them one with Manage access."}
                </p>
              </>
            )}
          </div>
        ) : null}
      </Modal>

      {/*
        A sign-in link, shown once. It is never mailed or stored anywhere
        this screen can show it again — it exists exactly once, here, for
        the admin to copy themselves.
      */}
      <Modal
        open={!!linkFor}
        onClose={() => setLinkFor(null)}
        title={linkFor ? `Sign-in link for ${linkFor.name}` : ""}
        footer={
          <Button variant="secondary" onClick={() => setLinkFor(null)}>
            Close
          </Button>
        }
      >
        {linkFor ? (
          <div className="text-sm leading-[21px] text-body">
            <p>
              Works once, and expires in {linkFor.expiresInMinutes} minutes.
              Opening it signs that browser out of whatever account it
              currently holds and into {linkFor.name}&rsquo;s — their own
              password and sessions elsewhere are untouched.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                readOnly
                value={linkFor.url}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded-[4px] border border-line bg-canvas px-2.5 text-[13px] text-ink"
              />
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(linkFor.url);
                    push("Link copied");
                  } catch {
                    push("The browser blocked the clipboard.", "error");
                  }
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Which payroll row this account is. Keyed on the person for the same
          reason the access dialog is: fresh initial state on a remount beats an
          effect resetting it when a prop changes. */}
      {linking ? (
        <EmployeeLinkDialog
          key={linking.userId}
          row={linking}
          onClose={() => setLinking(null)}
          onDone={(r) => {
            say(r);
            setLinking(null);
          }}
        />
      ) : null}

      {/* Managing somebody already on the list: straight to the apps. Keyed on
          the person, so the draft is initial state on a fresh mount rather than
          something an effect has to reset. */}
      {managing ? (
        <AccessDialog
          key={managing.userId}
          rows={allRows}
          person={managing}
          onClose={() => setManaging(null)}
          onDone={(r) => {
            say(r);
            setManaging(null);
          }}
          onSaved={say}
        />
      ) : null}

      {/* The same page the grant flow ends on, reached from a row. Keyed on
          the person so a second person opens a fresh one rather than the last
          one's password. */}
      {crediting ? (
        <Modal
          open
          onClose={() => setCrediting(null)}
          width={720}
          title={`A password for ${crediting.name}`}
          footer={
            <Button variant="primary" onClick={() => setCrediting(null)}>
              Done
            </Button>
          }
        >
          <CredentialStep
            key={crediting.userId}
            userId={crediting.userId}
            name={crediting.name}
            created={false}
            phone={crediting.phone}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function PersonCells({ row, onOpen }: { row: AccessRow; onOpen: () => void }) {
  return (
    <>
      <Td className="align-top font-medium text-ink">
        <button
          onClick={onOpen}
          className="cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-ink hover:text-brand"
        >
          {row.name}
        </button>
        <span className="block text-[13px] font-normal text-muted">{row.email}</span>
      </Td>
      <Td className="align-top">
        {row.active ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-body">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Enabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-danger">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            Disabled
          </span>
        )}
      </Td>
      <Td className="align-top">{LEVEL_LABELS[row.role] ?? row.role}</Td>
      <Td className="align-top">
        {row.employeeCode ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {row.employeeCode}
            {row.employeeStatus === "active" ? null : (
              <Badge tone="warn">
                {row.employeeStatus === "inactive" ? "Left" : "Status unknown"}
              </Badge>
            )}
            {/* Chosen, or merely matched. A guess and an answer look identical
                on a row, and one of them is deciding whose salary shows up. */}
            {row.employeeMatch === "guessed" ? (
              <Badge tone="warn" title="Matched on email or work number, not chosen. Link them to be sure.">
                Guessed
              </Badge>
            ) : null}
          </span>
        ) : (
          // Said rather than left blank: the HRMS check could not be made for
          // this person, and whoever reads the row should know that.
          <span className="text-muted">Not in HRMS</span>
        )}
      </Td>
    </>
  );
}

function PersonMenu({
  row,
  say,
  onManage,
  onSwitch,
  onOpen,
  onLinkEmployee,
  onCredential,
  onGotLink,
}: {
  row: AccessRow;
  say: (r: { ok: boolean; message?: string; error?: string }) => void;
  onManage: () => void;
  onSwitch: () => void;
  onOpen: () => void;
  onLinkEmployee: () => void;
  onCredential: () => void;
  onGotLink: (link: { name: string; url: string; expiresInMinutes: number }) => void;
}) {
  return (
    <RowMenu
      items={[
        {
          label: "Manage access",
          disabled: !row.active,
          title: row.active ? undefined : "This account cannot sign in",
          onSelect: onManage,
        },
        {
          label: row.active ? "Disable this sign-in" : "Enable this sign-in",
          destructive: row.active,
          onSelect: onSwitch,
        },
        { label: "Open their record", onSelect: onOpen },
        {
          /* Not hidden where a row was already guessed: a guess is exactly what
             somebody would come here to confirm or correct. */
          label:
            row.employeeMatch === "linked"
              ? "Change the HRMS record"
              : "Link an HRMS record",
          onSelect: onLinkEmployee,
        },
        {
          /* Two ways to give somebody a password and they are not the same
             act: this one goes to a mailbox and lets them choose it, which is
             better wherever they have a work email they read. The one below
             is for everybody else — most of the field staff. */
          label: "Email a password-reset link",
          disabled: !row.active || !row.email,
          title: !row.active
            ? "This account cannot sign in"
            : !row.email
              ? "This account has no work email to send a link to. Generate a password to read out instead."
              : undefined,
          onSelect: () => void sendPasswordResetFor(row.userId).then(say),
        },
        {
          label: "Generate a password to read out",
          destructive: true,
          disabled: !row.active,
          title: row.active
            ? "Replaces their current password and signs them out everywhere"
            : "This account cannot sign in",
          onSelect: onCredential,
        },
        {
          label: "End every session",
          onSelect: () => void endSessionsFor(row.userId).then(say),
        },
        /* Only a platform administrator may sign in as somebody else — see
           `mintImpersonationLink` — and the whole menu is drawn only for one,
           so the item needs no gate of its own. */
        {
          label: `Login as ${row.name.split(" ")[0]}`,
          disabled: !row.active,
          title: row.active
            ? "Opens a one-time link that signs in as this person, with no password"
            : "This account cannot sign in",
          onSelect: () =>
            void mintImpersonationLink(row.userId).then((r) => {
              if (r.ok) onGotLink({ name: row.name, ...r.data });
              else say(r);
            }),
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------- the dialog */

type Step = "who" | "access" | "review" | "done";

/** What somebody holds today, as the dialog's draft: app → modules ticked. */
function draftOf(row: AccessRow | null): Draft {
  const out: Draft = {};
  for (const g of row?.grants ?? []) {
    out[g.app] = g.modules.filter((m) => m.granted).map((m) => m.key);
  }
  return out;
}

/** The level each app is held under today. Never the account's: see `AppGrant.role`. */
function levelsOf(row: AccessRow | null): Record<string, RoleId> {
  const out: Record<string, RoleId> = {};
  for (const g of row?.grants ?? []) out[g.app] = g.role;
  return out;
}

function AccessDialog({
  person,
  rows,
  onClose,
  onDone,
  onSaved,
}: {
  /** Somebody already on the list. Absent means start from the picker. */
  person?: AccessRow;
  /**
   * Everybody on the list, so somebody picked from the employee master who
   * ALREADY has an account starts from what they actually hold.
   *
   * The picker used to seed such a person with every app they held at its
   * default modules and no levels at all — so a CRM manager narrowed to six
   * screens, reached through Enable access rather than through their own row,
   * was offered back as a whole-CRM associate, and saving without looking
   * would have written exactly that.
   */
  rows: AccessRow[];
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
  /** Saved, but not finished with — the dialog is still open behind the toast. */
  onSaved: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [step, setStep] = React.useState<Step>(person ? "access" : "who");
  /** The account the review compares against: the row managed, or the one picked. */
  const [basis, setBasis] = React.useState<AccessRow | null>(person ?? null);
  const [chosen, setChosen] = React.useState<Candidate | null>(
    person
      ? {
          userId: person.userId,
          employeeId: null,
          employeeCode: person.employeeCode,
          name: person.name,
          email: person.email,
          phone: person.phone,
          department: person.department,
          position: null,
          office: null,
          employeeStatus: person.employeeStatus,
          accountActive: person.active,
          apps: person.grants.map((g) => g.app),
          blocked: null,
        }
      : null,
  );

  /** What they hold today, so the review can say what actually changes. */
  const before: Draft = React.useMemo(() => draftOf(basis), [basis]);
  const levelsBefore = React.useMemo(() => levelsOf(basis), [basis]);

  const [draft, setDraft] = React.useState<Draft>(before);
  /* THE ERP'S POWERS, beside the ERP grant: who verifies tests, who sees
     purchase money. Sent only while the ERP is ticked — unticking it takes the
     powers with it, the same as its screens. */
  const powersBefore = React.useMemo(() => basis?.erpPowers ?? [], [basis]);
  const [powers, setPowers] = React.useState<string[]>(powersBefore);
  /* HRMS's powers, the same way: who is HR, who approves leave, who runs
     payroll. Unticking HRMS takes them with it. */
  const hrmsPowersBefore = React.useMemo(() => basis?.hrmsPowers ?? [], [basis]);
  const [hrmsPowers, setHrmsPowers] = React.useState<string[]>(hrmsPowersBefore);
  /*
   * WHICH LEVEL EACH APP IS HELD UNDER, beside the screens it opens.
   *
   * A person is a manager in the CRM and a clerk in Accounts — different
   * powers over different data, not one power applied twice. Seeded from what
   * they hold today. An app ticked for the first time is held as an
   * ASSOCIATE until somebody chooses otherwise: it used to inherit the
   * account's own level, so ticking Accounts for a CRM manager quietly made
   * them an Accounts manager — order approval, granted by a checkbox that was
   * only meant to open a screen.
   */
  const [roleDraft, setRoleDraft] = React.useState<Record<string, RoleId>>(levelsBefore);
  const [email, setEmail] = React.useState(person?.email ?? "");
  const [phone, setPhone] = React.useState(person?.phone ?? "");
  const [saving, setSaving] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<Record<string, string>>({});

  const needsAccount = !!chosen && !chosen.userId;

  const pick = (c: Candidate) => {
    const existing = c.userId ? (rows.find((r) => r.userId === c.userId) ?? null) : null;
    setChosen(c);
    setBasis(existing);
    setEmail(c.email ?? "");
    setPhone(c.phone ?? "");
    // Somebody already holding apps arrives with what they hold — modules,
    // levels and powers — not empty and not defaulted: this dialog sets the
    // whole picture, so it has to start from the picture.
    setDraft(draftOf(existing));
    setRoleDraft(levelsOf(existing));
    setPowers(existing?.erpPowers ?? []);
    setHrmsPowers(existing?.hrmsPowers ?? []);
    setFieldError({});
    setStep("access");
  };

  /* WHAT THE SAVE PRODUCED, so the last page can ask the right question. A
     brand new account has a password nobody has ever been told; an existing
     one may have somebody signed in on theirs right now, and generating a
     replacement takes that away. Only this component knows which, so the
     wording lives here rather than being guessed at in the action. */
  const [saved, setSaved] = React.useState<{ created: boolean; userId: string } | null>(null);

  /** The level an app will be saved under. Unsaid is associate, as on the server. */
  const levelOf = (app: string): RoleId => roleDraft[app] ?? "associate";

  const submit = () => {
    if (!chosen) return;
    setSaving(true);
    setFieldError({});
    void setAccess({
      userId: chosen.userId,
      employeeId: chosen.employeeId,
      grants: Object.entries(draft).map(([app, modules]) => ({
        app,
        modules,
        role: levelOf(app),
      })),
      erpPowers: draft.erp ? powers : [],
      hrmsPowers: draft.hrms ? hrmsPowers : [],
      /* No level on the account. It is DERIVED from the per-app levels by the
         action, and the select that used to sit here could make a platform
         administrator out of somebody given nothing but associate grants. */
      account: chosen.userId ? undefined : { email: email.trim() || null, phone: phone.trim() || null },
    }).then((r) => {
      setSaving(false);
      if (!r.ok && r.fieldErrors?.length) {
        // A field error belongs to the page that carries the field, so the
        // review page hands back rather than showing a message about a box
        // that is not on it.
        setFieldError(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
        setStep("access");
        return;
      }
      /* SAVED, AND THE DIALOG STAYS OPEN TO ASK ONE MORE THING. The access is
         written and the toast says so — nothing here is pending — but a person
         who cannot sign in has not been set up, and the moment the office is
         thinking about this person is the only moment they will do anything
         about it. Closing on success is what left every new account holding a
         password nobody knew. */
      if (r.ok) {
        setSaved({ created: r.data.created, userId: r.data.userId });
        setStep("done");
        onSaved(r);
        return;
      }
      onDone(r);
    });
  };

  const powersAfter = draft.erp ? powers : [];
  const powersChanged = powersAfter.length !== powersBefore.length || powersAfter.some((p) => !powersBefore.includes(p));
  const levelsAfter: Record<string, RoleId> = Object.fromEntries(Object.keys(draft).map((a) => [a, levelOf(a)]));
  const moduleChanges = describeChanges(before, draft, levelsBefore, levelsAfter);
  const hrmsPowersAfter = draft.hrms ? hrmsPowers : [];
  const hrmsPowersChanged =
    hrmsPowersAfter.length !== hrmsPowersBefore.length || hrmsPowersAfter.some((p) => !hrmsPowersBefore.includes(p));
  const changes = { ...moduleChanges, any: moduleChanges.any || powersChanged || hrmsPowersChanged };

  return (
    <Modal
      open
      onClose={onClose}
      width={1000}
      title={
        step === "who"
          ? "Enable access — who"
          : step === "access"
            ? `What ${chosen?.name} can open`
            : step === "review"
              ? `Review — ${chosen?.name}`
              : `${chosen?.name} can now sign in`
      }
      footer={
        step === "done" ? (
          /* One way out, and it is not "Cancel" — there is nothing left to
             cancel. The access is written whatever happens on this page. */
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                if (step === "review") return setStep("access");
                if (step === "access" && !person) return setStep("who");
                onClose();
              }}
            >
              {step === "review" || (step === "access" && !person) ? "Back" : "Cancel"}
            </Button>
            {step === "access" ? (
              <Button variant="primary" onClick={() => setStep("review")}>
                Review
              </Button>
            ) : step === "review" ? (
              <Button
                variant={changes.revoked.length ? "danger" : "primary"}
                disabled={saving || !changes.any}
                title={changes.any ? undefined : "Nothing has changed"}
                onClick={submit}
              >
                {saving ? "Saving…" : "Grant access"}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {step === "who" ? (
        <WhoStep onPick={pick} />
      ) : step === "access" ? (
        <AccessStep
          needsAccount={needsAccount}
          name={chosen?.name ?? ""}
          email={email}
          phone={phone}
          onEmail={setEmail}
          onPhone={setPhone}
          draft={draft}
          held={before}
          onDraft={setDraft}
          roleDraft={roleDraft}
          onRoleDraft={setRoleDraft}
          fieldError={fieldError}
          powers={powers}
          onPowers={setPowers}
          hrmsPowers={hrmsPowers}
          onHrmsPowers={setHrmsPowers}
        />
      ) : step === "review" ? (
        <ReviewStep
          name={chosen?.name ?? ""}
          creating={needsAccount}
          email={email}
          phone={phone}
          changes={changes}
          draft={draft}
          levels={levelsAfter}
          powerChange={powersChanged ? { before: powersBefore, after: powersAfter } : null}
          hrmsPowerChange={hrmsPowersChanged ? { before: hrmsPowersBefore, after: hrmsPowersAfter } : null}
        />
      ) : (
        <CredentialStep
          userId={saved?.userId ?? ""}
          name={chosen?.name ?? ""}
          created={saved?.created ?? false}
          phone={phone.trim() || chosen?.phone || null}
        />
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- step four */

/**
 * The page that ASKS.
 *
 * Granting access does not mint a password — the office decides. A credential
 * that appeared unasked would be one left on a screen somebody walks away
 * from, and on an existing account it would sign somebody out mid-call with no
 * warning at all.
 *
 * What it exists to prevent is the state this flow used to end in: an account
 * granted four apps, a welcome email telling the employee to wait for a code
 * that is never sent, and a password `randomUUID()` chose. Everything was
 * green and nobody could sign in.
 */
function CredentialStep({
  userId,
  name,
  created,
  phone,
}: {
  userId: string;
  name: string;
  /** Whether the grant that just ran created the account. */
  created: boolean;
  phone: string | null;
}) {
  const [issued, setIssued] = React.useState<IssuedCredential | null>(null);
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const first = name.split(" ")[0];

  const generate = () => {
    setWorking(true);
    setError(null);
    void issueCredential(userId).then((r) => {
      setWorking(false);
      if (r.ok) setIssued(r.data);
      else setError(r.error);
    });
  };

  if (issued) {
    return (
      <div>
        <div className="rounded-[4px] border border-line bg-canvas px-4 py-3.5">
          <p className="text-[13px] text-body">
            Read this out to {first}, or copy it into a message. {" "}
            <span className="font-medium text-ink">
              It is not stored anywhere and cannot be shown again
            </span>{" "}
            — closing this box is the last time anyone sees it.
          </p>

          <div className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Signs in with
            </span>
            <span className="font-mono text-[15px] text-ink">{issued.signInWith}</span>

            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Password
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="rounded-[4px] border border-line bg-surface px-2.5 py-1 font-mono text-[19px] tracking-[0.08em] text-ink select-all">
                {issued.password}
              </span>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(issued.password)
                    .then(() => setCopied(true))
                    .catch(() => setError("This browser would not let the page copy. Read it out instead."));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </span>
          </div>

          {/* THE DASH COUNTS. It is in the string and in the hash, so somebody
              who leaves it out is refused — which reads as a wrong password
              rather than as a mistyped one. */}
          <p className="mt-3 text-[13px] text-muted">
            The dash is part of the password. Letters are capitals. Ask {first} to
            change it once they are in, from Forgot password on the sign-in screen.
          </p>
        </div>

        {issued.sessionsEnded > 0 ? (
          <p className="mt-3 text-[13px] text-body">
            {issued.sessionsEnded === 1
              ? `${first} was signed in somewhere and has been signed out — the old password no longer works.`
              : `${first} was signed in on ${issued.sessionsEnded} devices and has been signed out of all of them — the old password no longer works.`}
          </p>
        ) : null}

        {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-[4px] border border-line bg-canvas px-4 py-3.5">
        <p className="text-[15px] font-medium text-ink">
          {created
            ? `Generate a password for ${first}?`
            : `Give ${first} a new password?`}
        </p>
        <p className="mt-1.5 text-[13px] text-body">
          {created ? (
            <>
              The account exists and the apps are granted, but nobody can sign into it
              yet — a new account is created with a password nobody knows, and nothing
              has been emailed to anyone. Generate one to read out or paste into a
              message. If {first} has a work email they can set their own instead, from
              Forgot password on the sign-in screen.
            </>
          ) : (
            <>
              Only if they cannot get in. This{" "}
              <span className="font-medium text-ink">replaces the password they have now</span>{" "}
              and signs them out everywhere, so do not do it to somebody who is working.
              A reset link from their row menu lets them choose their own instead.
            </>
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant={created ? "primary" : "danger"}
            disabled={working || !userId}
            onClick={generate}
          >
            {working
              ? "Generating…"
              : created
                ? "Generate a password"
                : "Replace their password"}
          </Button>
          <span className="text-[13px] text-muted">
            {phone
              ? `They sign in with ${phone} and this password.`
              : "They sign in with their work email and this password."}
          </span>
        </div>
        {error ? <p className="mt-2.5 text-[13px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- step one */

function WhoStep({ onPick }: { onPick: (c: Candidate) => void }) {
  const [people, setPeople] = React.useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [reload, setReload] = React.useState(0);

  // Read on open rather than passed down with the page: somebody who has just
  // been added to the employee sheet and synced is pickable without a reload.
  //
  // The effect starts the read and nothing else — the state lands in the
  // promise's callback, which is what keeps it out of the render path the
  // React Compiler rules are about.
  React.useEffect(() => {
    let live = true;
    void candidatesForGrant().then((r) => {
      if (!live) return;
      if (r.ok) setPeople(r.data);
      else setLoadError(r.error);
    });
    return () => {
      live = false;
    };
  }, [reload]);

  const matches = (people ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.email, c.phone, c.employeeCode, c.department, c.position]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  return (
    <div>
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          placeholder="Search the employee master and the accounts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setPeople(null);
            setLoadError(null);
            setReload((n) => n + 1);
          }}
        >
          Refresh
        </Button>
      </div>
      <p className="mt-1.5 text-[13px] leading-[19px] text-muted">
        Everybody HRMS knows about, and every account that exists. Only somebody active in
        HRMS can be given access — a leaver is listed with the reason rather than hidden.
      </p>

      {loadError ? (
        <p className="mt-4 text-sm text-danger">{loadError}</p>
      ) : people === null ? (
        <p className="mt-4 text-sm text-muted">Reading the employee master…</p>
      ) : matches.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Nobody matches “{query}”.</p>
      ) : (
        <div className="mt-2 max-h-[52vh] overflow-auto rounded-[4px] border border-line">
          {matches.map((c) => (
            <button
              key={c.employeeId ?? c.userId}
              disabled={!!c.blocked}
              title={c.blocked ?? undefined}
              onClick={() => onPick(c)}
              className={cx(
                "flex w-full items-baseline gap-2.5 border-0 border-b border-divider bg-transparent px-2.5 py-1.5 text-left last:border-b-0",
                c.blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-canvas",
              )}
            >
              {/* One line per person: the name, then everything that tells
                  two people of the same name apart, in the space left over. */}
              <span className="w-[13rem] flex-none truncate text-[13px] font-medium text-ink">
                {c.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                {[c.employeeCode, c.position ?? c.department, c.email ?? c.phone]
                  .filter(Boolean)
                  .join(" · ") || "No contact details on file"}
              </span>
              {c.blocked ? (
                <span className="flex-none text-[11px] whitespace-nowrap text-muted">
                  {c.blocked}
                </span>
              ) : (
                <>
                  {c.userId ? null : (
                    <span className="flex-none rounded-[3px] bg-brand-soft px-1.5 text-[11px] font-medium text-[#5223E0]">
                      no account
                    </span>
                  )}
                  {c.employeeStatus === null ? (
                    <span className="flex-none text-[11px] whitespace-nowrap text-muted">
                      not in HRMS
                    </span>
                  ) : null}
                  <span className="w-[3.5rem] flex-none text-right text-[11px] whitespace-nowrap text-muted">
                    {c.apps.length
                      ? `${c.apps.length} app${c.apps.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- step two */

/**
 * Every app, and every module of every app, on one page.
 *
 * The app's own checkbox is derived rather than stored: an app is granted if
 * and only if at least one of its modules is ticked. That removes the one
 * invalid state this screen could otherwise express — an app held with nothing
 * inside it, whose every route redirects somewhere else — instead of drawing it
 * and then refusing it at the save.
 *
 * It is DENSE on purpose. Somebody setting up a telecaller is answering forty
 * small yes-or-no questions, and the answer to each is one word — so the space
 * belongs to the words, not around them. Every module in an app is meant to be
 * readable without scrolling past the app it belongs to; the sentence
 * explaining what unticking does is said once at the top rather than repeated
 * inside all seven blocks.
 */
function AccessStep({
  needsAccount,
  name,
  email,
  phone,
  onEmail,
  onPhone,
  draft,
  held,
  onDraft,
  roleDraft,
  onRoleDraft,
  fieldError,
  powers,
  onPowers,
  hrmsPowers,
  onHrmsPowers,
}: {
  needsAccount: boolean;
  name: string;
  email: string;
  phone: string;
  onEmail: (v: string) => void;
  onPhone: (v: string) => void;
  draft: Draft;
  /** What they held when the dialog opened — a retired app is drawn only if it is here. */
  held: Draft;
  onDraft: (next: Draft) => void;
  /** The level each granted app is held under. Absent is associate. */
  roleDraft: Record<string, RoleId>;
  onRoleDraft: (next: Record<string, RoleId>) => void;
  fieldError: Record<string, string>;
  /** The ERP's special powers, drawn under the ERP app while it is ticked. */
  powers: string[];
  onPowers: (next: string[]) => void;
  /** HRMS's special powers, drawn under HRMS while it is ticked. */
  hrmsPowers: string[];
  onHrmsPowers: (next: string[]) => void;
}) {
  const setApp = (app: AppId, modules: string[]) => {
    const next = { ...draft };
    if (modules.length) next[app] = modules;
    else delete next[app];
    onDraft(next);
  };

  const apps = Object.keys(draft).length;
  const screens = Object.values(draft).reduce((n, m) => n + m.length, 0);

  return (
    <div className="-mx-1">
      {needsAccount ? (
        <div className="mb-3 rounded-[4px] border border-line bg-canvas px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-ink">
              {name} has no MahekOne account yet
            </span>
            <span className="text-[13px] text-muted">
              One is created when you grant access. Give them a work number or an email —
              either one signs them in, and with both they pick. No password is typed
              here; you generate one to read out on the last page.
            </span>
          </div>
          {/* NO ACCOUNT LEVEL. There was a Role select here beside the two
              sign-ins, and it was a second answer to a question the per-app
              levels below already answer: "Admin" chosen here with
              "Associate" on every app produced a platform administrator
              nobody had meant. The account level is derived from the grants
              by the action, and is shown on the list once it exists. */}
          <div className="mt-2 grid grid-cols-2 gap-2">
            {/* NEITHER IS STARRED, because neither on its own is required —
                what is required is one of the two, which is a sentence about
                the pair and belongs above them rather than on either. */}
            <Field
              label="Work email"
              hint={phone.trim() ? "Optional" : undefined}
              error={fieldError.email}
            >
              <Input
                value={email}
                placeholder="priya@mahek.in"
                onChange={(e) => onEmail(e.target.value)}
              />
            </Field>
            <Field
              label="Work number"
              hint={email.trim() ? "Optional" : undefined}
              error={fieldError.phone}
            >
              <Input
                value={phone}
                placeholder="9820011001"
                inputMode="numeric"
                onChange={(e) => onPhone(e.target.value)}
              />
            </Field>
          </div>
        </div>
      ) : null}

      {/* Said once, above all of them, rather than seven times inside them. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1 pb-2">
        <span className="text-[13px] text-body">
          Tick an app to grant it; untick a screen to withhold it. A withheld screen is not
          drawn in their navigation. The level beside an app says what they may do in it.
        </span>
        <span className="flex-1" />
        <span className="text-[13px] whitespace-nowrap text-muted">
          {apps} app{apps === 1 ? "" : "s"} · {screens} screen{screens === 1 ? "" : "s"}
        </span>
      </div>

      {fieldError.grants ? (
        <p className="px-1 pb-2 text-[13px] text-danger">{fieldError.grants}</p>
      ) : null}

      <div className="overflow-hidden rounded-[4px] border border-line">
        {/* A retired app is drawn only while somebody HELD it when the dialog
            opened, so the grant can be taken away — and it stays drawn after
            it is unticked, so the untick can be taken back. It is never
            offered to anybody who did not already hold it. */}
        {APPS.filter((a) => !a.retiredInto || held[a.id]).map((app, i) => (
          <AppBlock
            key={app.id}
            app={app.id}
            name={app.name}
            description={app.description}
            built={app.built}
            retired={!!app.retiredInto}
            ticked={draft[app.id] ?? []}
            first={i === 0}
            role={roleDraft[app.id] ?? "associate"}
            onRole={(next) => {
              onRoleDraft({ ...roleDraft, [app.id]: next });
              /* COMING DOWN FROM ADMIN TAKES THE ADMINISTRATOR'S SCREENS WITH
                 IT. An administrator holds every off-by-default screen
                 whatever was ticked, so their draft arrives with those boxes
                 ticked; left as they were, a demotion would write them down as
                 real rows and the manager would keep the calling desk the
                 administrator only had by being one. They are unticked here,
                 where the review shows it as a narrowing, and ticking one back
                 is a deliberate act. */
              const was = roleDraft[app.id] ?? "associate";
              const ticked = draft[app.id];
              if (was === "admin" && next !== "admin" && ticked) {
                const offByDefault = new Set(modulesForApp(app.id).filter((m) => m.offByDefault).map((m) => m.key));
                const kept = ticked.filter((k) => !offByDefault.has(k));
                if (kept.length !== ticked.length && kept.length) setApp(app.id, kept);
              }
            }}
            onChange={(modules) => setApp(app.id, modules)}
            powers={
              app.id === "erp"
                ? { held: powers, onChange: onPowers, error: fieldError.erpPowers, list: ERP_POWERS, labels: ERP_POWER_LABEL, adminLine: "An ERP administrator holds every power." }
                : app.id === "hrms"
                  ? { held: hrmsPowers, onChange: onHrmsPowers, error: fieldError.hrmsPowers, list: HRMS_POWERS, labels: HRMS_POWER_LABEL, adminLine: "An HRMS administrator holds every power." }
                  : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One app: a single line, and its screens underneath when it is granted.
 *
 * The screens sit in a grid with the sidebar group named down the left, which
 * is the shape the app itself has — somebody who has used the CRM is looking
 * for "Collections" and then for the row within it, not reading forty labels in
 * sequence.
 */
function AppBlock({
  app,
  name,
  description,
  built,
  retired,
  ticked,
  first,
  role,
  onRole,
  onChange,
  powers,
}: {
  app: AppId;
  name: string;
  description: string;
  built: boolean;
  /** Retired into another app: drawn only while held, so it can be taken away. */
  retired: boolean;
  ticked: string[];
  first: boolean;
  role: RoleId;
  onRole: (next: RoleId) => void;
  onChange: (modules: string[]) => void;
  /** An app's special powers — the ERP's and HRMS's — beside its screens. */
  powers?: {
    held: string[];
    onChange: (next: string[]) => void;
    error?: string;
    list: readonly string[];
    labels: Record<string, { label: string; source: string }>;
    adminLine: string;
  };
}) {
  const all = ALL_OF(app);
  const always = ALWAYS_OF(app);
  /* A write level is not a screen: it is drawn as Read / Write on the row of
     the screen it belongs to, and counted nowhere a screen is counted. */
  const writeOf = new Map(modulesForApp(app).filter((m) => m.writeOf).map((m) => [m.writeOf!, m.key]));
  const isWrite = new Set(writeOf.values());
  const groups = moduleGroupsForApp(app).map((g) => ({ ...g, modules: g.modules.filter((m) => !isWrite.has(m.key)) }));
  const screens = all.filter((k) => !isWrite.has(k));
  const tickedScreens = ticked.filter((k) => !isWrite.has(k));
  const readOnly = [...writeOf].filter(([screen, write]) => ticked.includes(screen) && !ticked.includes(write));
  const on = ticked.length > 0;
  const whole = ticked.length >= all.length;
  /* A screen changed by hand never drops the always-open ones: they are held
     whatever is ticked, and a draft that left them out would describe a grant
     narrower than the one the app actually enforces. A write level never
     outlives its screen — the server drops one that does, and so does this. */
  const change = (next: string[]) =>
    onChange(
      [...new Set([...always, ...next])].filter((k) => {
        const screen = [...writeOf].find(([, w]) => w === k)?.[0];
        return !screen || next.includes(screen);
      }),
    );
  /* What the chosen level lets them DO, read off the capability matrix the
     server enforces — never a sentence typed here. See `capability-labels`. */
  const carries = on ? levelCarries(app, role) : [];

  return (
    <div className={cx(first ? "" : "border-t border-line")}>
      <div
        className={cx(
          "flex items-center gap-2 px-2.5 py-1.5",
          on ? "bg-brand-soft" : "hover:bg-canvas",
        )}
      >
        <Checkbox
          checked={on}
          aria-label={name}
          // The description rides on the title. On one line per app the whole
          // registry is visible at once, which is what makes this page a
          // decision rather than a scroll.
          title={description}
          onChange={() => onChange(on ? [] : DEFAULT_OF(app))}
          label={<span className="text-[13px] font-medium text-ink">{name}</span>}
        />
        {retired ? (
          <span
            className="text-[11px] whitespace-nowrap text-warn-ink"
            title="This app was retired. It can be taken away from somebody who still holds it, and is never granted again."
          >
            retired — can only be taken away
          </span>
        ) : built ? null : (
          <span className="text-[11px] whitespace-nowrap text-muted">not built yet</span>
        )}
        <span className="flex-1" />
        {/*
          THE LEVEL, on the app's own line and only while it is granted.

          A level picker on an app nobody holds is a question about nothing,
          and it would read as though the level were the thing being granted.
          It sits before the module count because it is the more consequential
          of the two: withholding a screen hides a link, choosing a level
          decides what the person may DO with the ones they keep.
        */}
        {on ? (
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] whitespace-nowrap text-muted">as</span>
            <select
              value={role}
              aria-label={`Level on ${name}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onRole(e.target.value as RoleId)}
              className="h-6 cursor-pointer rounded-[3px] border border-line bg-surface px-1 text-[11px] text-body"
            >
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {levelOptionLabel(r.id, app, name)}
                </option>
              ))}
            </select>
          </span>
        ) : null}
        {on && !whole ? (
          <span className="rounded-[3px] bg-warn-soft px-1.5 text-[11px] font-medium text-warn-ink">
            {tickedScreens.length < screens.length
              ? `${tickedScreens.length}/${screens.length}`
              : `all ${screens.length}`}
            {readOnly.length ? " · read only" : ""}
          </span>
        ) : (
          <span className="text-[11px] whitespace-nowrap text-muted">
            {!on
              ? `${screens.length} screen${screens.length === 1 ? "" : "s"}`
              : screens.length === 1
                ? "granted"
                : `all ${screens.length}`}
          </span>
        )}
        {on && !whole ? (
          <button
            onClick={() => onChange(all)}
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-brand-hover hover:text-brand"
          >
            all
          </button>
        ) : (
          // Kept in the layout so the rows do not jump as boxes are ticked.
          <span className="w-[18px]" />
        )}
      </div>

      {/* WHAT THE LEVEL CARRIES, under the line that chooses it. Short lines,
          in the order the matrix lists them, so "Approve and decline orders"
          appears or disappears in the same place as the select changes. */}
      {on ? (
        <div className="flex items-start gap-2 border-t border-divider bg-surface px-2.5 py-1">
          <span className="w-[132px] flex-none pt-[3px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            {LEVEL_LABELS[role]} carries
          </span>
          <span className="min-w-0 flex-1 text-[12px] leading-[18px] text-body">
            {carries.join(" · ")}
          </span>
        </div>
      ) : null}

      {/* The screens appear once the app is ticked. Drawing forty checkboxes
          nobody can act on would bury the seven decisions that matter.

          An app with ONE screen draws none of them: its checkbox already is
          that screen, and a row repeating the app's own name under itself is
          furniture rather than a decision. */}
      {on && all.length > 1 ? (
        <div className="border-t border-divider bg-surface px-2.5 py-1">
          {groups.map((g) => (
            <div
              key={g.group}
              className="flex items-start gap-2 border-b border-divider py-1 last:border-b-0"
            >
              <span className="w-[132px] flex-none pt-[3px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
                {g.group}
              </span>
              <span className="grid min-w-0 flex-1 grid-cols-3 gap-x-3">
                {g.modules.map((m) =>
                  isAlwaysOpen(m.key) ? (
                    /* ALWAYS ON, AND DRAWN THAT WAY. The app opens this screen
                       for every holder whatever is ticked, so a checkbox that
                       could be unticked would be a control that changes
                       nothing — the one kind that teaches somebody the page
                       is lying to them. The title is on a wrapper because a
                       disabled input swallows its own hover. */
                    <span
                      key={m.key}
                      className="min-w-0"
                      title={`Always open — everybody who holds ${name} reaches this screen whatever is ticked.${m.note ? ` ${m.note}` : ""}`}
                    >
                      <Checkbox
                        checked
                        disabled
                        readOnly
                        className="min-w-0 cursor-default py-[1px]"
                        label={<span className="truncate text-[13px] text-muted">{m.label} · always</span>}
                      />
                    </span>
                  ) : writeOf.has(m.key) ? (
                    /* A SCREEN WITH TWO LEVELS. Ticking it grants both, which
                       is what holding it has always meant; the select is the
                       only way to read-only, so it is a choice somebody made. */
                    <span key={m.key} className="flex min-w-0 items-center gap-1.5">
                      <Checkbox
                        checked={ticked.includes(m.key)}
                        title={m.note}
                        onChange={() =>
                          change(
                            ticked.includes(m.key)
                              ? ticked.filter((k) => k !== m.key)
                              : [...ticked, m.key, writeOf.get(m.key)!],
                          )
                        }
                        className="min-w-0 py-[1px]"
                        label={<span className="truncate text-[13px] text-body">{m.label}</span>}
                      />
                      {ticked.includes(m.key) ? (
                        <select
                          value={ticked.includes(writeOf.get(m.key)!) ? "write" : "read"}
                          aria-label={`${m.label} access`}
                          title="Read: the chats and the message log. Write: also reply, send, runs, templates and groups."
                          onChange={(e) => {
                            const w = writeOf.get(m.key)!;
                            const rest = ticked.filter((k) => k !== w);
                            change(e.target.value === "write" ? [...rest, w] : rest);
                          }}
                          className="h-5 flex-none cursor-pointer rounded-[3px] border border-line bg-surface px-0.5 text-[11px] text-body"
                        >
                          <option value="read">Read</option>
                          <option value="write">Write</option>
                        </select>
                      ) : null}
                    </span>
                  ) : (
                    <Checkbox
                      key={m.key}
                      checked={ticked.includes(m.key)}
                      // What withholding it costs rides on the title rather than
                      // in the layout: forty sentences on one page is clutter
                      // rather than help, the same trade the microphone's own
                      // guidance makes.
                      title={m.note}
                      onChange={() =>
                        change(
                          ticked.includes(m.key)
                            ? ticked.filter((k) => k !== m.key)
                            : [...ticked, m.key],
                        )
                      }
                      className="min-w-0 py-[1px]"
                      label={<span className="truncate text-[13px] text-body">{m.label}</span>}
                    />
                  ),
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* THE POWERS, under the screens they act on. An administrator of the
          app holds every one without a tick, so the boxes would be a question
          with no effect; the line says so instead. Drawn for whoever can see
          this dialog — a platform administrator, the only person the server
          lets save it — with no separate "may give powers" gate any more. */}
      {on && powers ? (
        <div className="flex items-start gap-2 border-t border-divider bg-surface px-2.5 py-1.5">
          <span className="w-[132px] flex-none pt-[3px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            Powers
          </span>
          {role === "admin" ? (
            <span className="text-[13px] text-muted">{powers.adminLine}</span>
          ) : (
            <span className="grid min-w-0 flex-1 grid-cols-3 gap-x-3">
              {powers.list.map((p) => (
                <Checkbox
                  key={p}
                  checked={powers.held.includes(p)}
                  title={powers.labels[p]?.source}
                  onChange={() => powers.onChange(powers.held.includes(p) ? powers.held.filter((x) => x !== p) : [...powers.held, p])}
                  className="min-w-0 py-[1px]"
                  label={<span className="truncate text-[13px] text-body">{powers.labels[p]?.label ?? p}</span>}
                />
              ))}
            </span>
          )}
        </div>
      ) : null}
      {on && powers?.error ? <p className="border-t border-divider px-2.5 py-1.5 text-[13px] text-danger">{powers.error}</p> : null}
    </div>
  );
}


/* -------------------------------------------------------------- step three */

type Changes = {
  granted: AppId[];
  revoked: AppId[];
  narrowed: AppId[];
  widened: AppId[];
  /**
   * An app kept, at a different LEVEL. This is the change that moves what
   * somebody may DO, and it used to be invisible: a dialog that only moved a
   * telecaller from associate to manager reported "Nothing has changed" and
   * disabled Save, so the one decision on the page with the largest
   * consequence could not be made at all.
   */
  releveled: Array<{ app: AppId; from: RoleId; to: RoleId }>;
  unchanged: AppId[];
  any: boolean;
};

function describeChanges(
  before: Draft,
  after: Draft,
  levelsBefore: Record<string, RoleId>,
  levelsAfter: Record<string, RoleId>,
): Changes {
  const beforeApps = Object.keys(before) as AppId[];
  const afterApps = Object.keys(after) as AppId[];

  const granted = afterApps.filter((a) => !beforeApps.includes(a));
  const revoked = beforeApps.filter((a) => !afterApps.includes(a));
  const narrowed: AppId[] = [];
  const widened: AppId[] = [];
  const releveled: Changes["releveled"] = [];
  const unchanged: AppId[] = [];

  for (const a of afterApps.filter((x) => beforeApps.includes(x))) {
    const was = before[a] ?? [];
    const now = after[a] ?? [];
    const from = levelsBefore[a] ?? "associate";
    const to = levelsAfter[a] ?? "associate";
    if (from !== to) releveled.push({ app: a, from, to });
    if (was.length === now.length && now.every((m) => was.includes(m))) {
      if (from === to) unchanged.push(a);
    } else if (now.length < was.length) narrowed.push(a);
    else widened.push(a);
  }

  return {
    granted,
    revoked,
    narrowed,
    widened,
    releveled,
    unchanged,
    any: granted.length + revoked.length + narrowed.length + widened.length + releveled.length > 0,
  };
}

/**
 * What is about to happen, in words, before anything is written.
 *
 * Revoking is why this page exists. It happens by unticking a box, which is a
 * small gesture for a large consequence — so the consequence is named, with
 * the app it takes away, on a page somebody has to pass through.
 */
function ReviewStep({
  name,
  creating,
  email,
  phone,
  changes,
  draft,
  levels,
  powerChange,
  hrmsPowerChange,
}: {
  name: string;
  creating: boolean;
  phone: string;
  email: string;
  changes: Changes;
  draft: Draft;
  /** The level each granted app will be held under, after this save. */
  levels: Record<string, RoleId>;
  /** The ERP powers before and after, where they change. */
  powerChange: { before: string[]; after: string[] } | null;
  /** The HRMS powers before and after, where they change. */
  hrmsPowerChange: { before: string[]; after: string[] } | null;
}) {
  const appName = (id: AppId) => APPS.find((a) => a.id === id)?.name ?? id;
  /* "Manager in Accounts", because a level on its own no longer names a hat
     and "Associate and Associate" is not a warning anybody can act on. */
  const hatName = (h: { app: string; level?: string }) =>
    `${h.level ? roleName(h.level as RoleId) : "Anyone"} in ${appName(h.app as AppId)}`;
  const roleOf = (id: AppId): RoleId => levels[id] ?? "associate";
  const roleName = (id: RoleId) => ROLES.find((r) => r.id === id)?.label ?? id;
  /* The level said the way the select said it, so "Admin — the whole
     platform" reads the same on the page that writes it as on the page that
     chose it — plus what it carries, from the same matrix. */
  const levelLine = (id: AppId, level: RoleId) =>
    `${levelOptionLabel(level, id, appName(id))}. Carries: ${levelCarries(id, level).join("; ")}.`;

  /*
   * WHAT THE COMBINATION LETS THEM DO, said before it is written.
   *
   * The capability matrix keeps approving orders away from managers on
   * purpose: the person chasing a target must not sign off the orders that hit
   * it. Several hats can put both on one person, and at nine people that is
   * sometimes the only way the work gets done — so it is allowed, and said
   * here in the words of the rule it bends, on the page where somebody is
   * deciding.
   */
  /* A hat is an app AND a level now, so the pair is compared on both — the
     ledger desk clashes with the calling book, and it is the Accounts
     MANAGER who decides, not the associate who records. */
  const heldHats = Object.keys(draft).map((a) => ({
    app: a,
    role: roleOf(a as AppId) as string,
  }));
  const conflicts = conflictsFor(heldHats);
  const scope = (id: AppId) => {
    /* Screens only: a write level is said in words after them, never counted
       as a screen, or "WhatsApp read only" would read as one screen fewer. */
    const mods = modulesForApp(id);
    const held = draft[id] ?? [];
    const screens = mods.filter((m) => !m.writeOf);
    const n = screens.filter((m) => held.includes(m.key)).length;
    const total = screens.length;
    const readOnly = mods
      .filter((m) => m.writeOf && held.includes(m.writeOf) && !held.includes(m.key))
      .map((m) => `${modulesForApp(id).find((x) => x.key === m.writeOf)?.label} read only`);
    const base =
      n >= total ? (total === 1 ? "its one screen" : `all ${total} screens`) : `${n} of ${total} screens`;
    return readOnly.length ? `${base}, ${readOnly.join(", ")}` : base;
  };

  const rows: Array<{
    key: string;
    tone: "success" | "warn" | "danger";
    tag: string;
    what: string;
    detail: string;
  }> = [
    ...(creating
      ? [
          {
            key: "account",
            tone: "success" as const,
            tag: "Create",
            what: name,
            /* WHAT THEY WILL TYPE INTO THE FIRST BOX, and nothing about mail.
               Granting access sends nothing now: it used to mint and email a
               reset link every time, which is a thing the office cannot see
               happen, cannot repeat, and which reaches nobody at all on an
               account with no address. The password is generated on the next
               page and read out. */
            detail: `signing in with ${[phone, email].filter(Boolean).join(" or ")}${
              phone && email ? " — whichever they prefer" : ""
            }. Their account level is worked out from the levels below.`,
          },
        ]
      : []),
    ...changes.granted.map((a) => ({
      key: `g:${a}`,
      tone: "success" as const,
      tag: "Grant",
      what: appName(a),
      detail: `${scope(a)}, as ${roleName(roleOf(a)).toLowerCase()}.`,
    })),
    /* A LEVEL ROW FOR EVERY APP GRANTED, as well as for every level changed,
       and with what the level carries spelled out. The grant line above says
       "as manager"; this says what that means, because a new grant's level
       is a decision as large as any change to an old one. */
    ...changes.granted.map((a) => ({
      key: `gl:${a}`,
      tone: "success" as const,
      tag: "Level",
      what: `${appName(a)}:`,
      detail: levelLine(a, roleOf(a)),
    })),
    ...changes.releveled.map(({ app: a, from, to }) => ({
      key: `l:${a}`,
      tone: (ROLES.findIndex((r) => r.id === to) < ROLES.findIndex((r) => r.id === from) ? "warn" : "success") as
        | "warn"
        | "success",
      tag: "Level",
      what: `${appName(a)}: ${roleName(from)} → ${roleName(to)}.`,
      detail: levelLine(a, to),
    })),
    ...changes.widened.map((a) => ({
      key: `w:${a}`,
      tone: "success" as const,
      tag: "Widen",
      what: appName(a),
      detail: `widened to ${scope(a)}.`,
    })),
    ...changes.narrowed.map((a) => ({
      key: `n:${a}`,
      tone: "warn" as const,
      tag: "Narrow",
      what: appName(a),
      detail: `${scope(a)} — the rest disappear from their navigation.`,
    })),
    ...(powerChange
      ? [
          {
            key: "powers",
            tone: (powerChange.after.length < powerChange.before.length ? "warn" : "success") as "warn" | "success",
            tag: "Powers",
            what: "ERP",
            detail: powerChange.after.length
              ? `${powerChange.after.map((p) => ERP_POWER_LABEL[p as keyof typeof ERP_POWER_LABEL]?.label ?? p).join(", ")}.`
              : "no ERP powers.",
          },
        ]
      : []),
    ...(hrmsPowerChange
      ? [
          {
            key: "hrms-powers",
            tone: (hrmsPowerChange.after.length < hrmsPowerChange.before.length ? "warn" : "success") as "warn" | "success",
            tag: "Powers",
            what: "HRMS",
            detail: hrmsPowerChange.after.length
              ? `${hrmsPowerChange.after.map((p) => HRMS_POWER_LABEL[p as keyof typeof HRMS_POWER_LABEL]?.label ?? p).join(", ")}.`
              : "no HRMS powers.",
          },
        ]
      : []),
    ...changes.revoked.map((a) => ({
      key: `r:${a}`,
      tone: "danger" as const,
      tag: "Revoke",
      what: appName(a),
      detail:
        "they stop opening it, a bookmarked link sends them to the launcher, and which screens they had is forgotten with the grant.",
    })),
  ];

  return (
    <div>
      {!changes.any ? (
        <p className="text-sm text-body">
          Nothing has changed. Go back and tick or untick something, or cancel.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[4px] border border-line">
          {rows.map((r, i) => (
            <div
              key={r.key}
              className={cx(
                "flex items-baseline gap-2.5 px-2.5 py-2",
                i ? "border-t border-divider" : "",
              )}
            >
              <span
                className={cx(
                  "w-[54px] flex-none rounded-[3px] px-1.5 py-0.5 text-center text-[11px] font-medium",
                  r.tone === "danger"
                    ? "bg-danger-soft text-danger"
                    : r.tone === "warn"
                      ? "bg-warn-soft text-warn-ink"
                      : "bg-success-soft text-success",
                )}
              >
                {r.tag}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-[13px] font-medium text-ink">{r.what}</span>{" "}
                <span className="text-[13px] leading-[19px] text-muted">{r.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {conflicts.length ? (
        <div className="mt-2 rounded-[4px] border border-warn bg-warn-soft px-3 py-2.5">
          <div className="text-[13px] font-medium text-warn-ink">
            {name} will wear {heldHats.length} hats at once
          </div>
          {conflicts.map((c) => (
            <p
              key={c.hats.map((h) => `${h.app}:${h.level ?? "any"}`).join("+")}
              className="mt-1 text-[13px] leading-[19px] text-warn-ink"
            >
              <span className="font-medium">
                {hatName(c.hats[0])} and {hatName(c.hats[1])}:
              </span>{" "}
              {c.sentence}
            </p>
          ))}
          <p className="mt-1.5 text-[12px] leading-[18px] text-warn-ink">
            This is allowed — in a company this size the same person often has
            to do both. Every action taken under it records which hat allowed
            it, so the audit can answer for it later.
          </p>
        </div>
      ) : null}

      {changes.unchanged.length ? (
        <p className="mt-2 text-[13px] text-muted">
          Unchanged: {changes.unchanged.map(appName).join(", ")}.
        </p>
      ) : null}

      {changes.any && Object.keys(draft).length === 0 ? (
        <p className="mt-2 text-[13px] leading-[19px] text-warn-ink">
          This leaves {name} with no app at all. They can still sign in, onto a launcher that
          says so plainly rather than a blank screen.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------- which payroll row this is */

/**
 * Saying which HRMS employee an account is.
 *
 * Salary, days worked and reimbursements are all read by joining the account to
 * the employee master, and until this existed that join was a guess on the
 * email or the company mobile. On the real book the guess finds almost nobody —
 * most employees carry no email at all, the accounts are `@mahek.in` while the
 * sheet holds personal addresses, and the work numbers on the accounts are not
 * the company mobiles in the sheet — so every field salesman's salary screen
 * was blank, in a way that looked exactly like being paid nothing.
 *
 * It is a picker rather than a matcher on purpose. The master carries two rows
 * for the same man at two different salaries sharing one mobile, so there is a
 * real question here that only a person can answer, and a screen that answered
 * it automatically would be deciding somebody's pay on a coin toss.
 *
 * A row already spoken for is shown and refused rather than hidden: somebody
 * hunting for an employee they cannot find would otherwise conclude the search
 * is broken when the answer is that a colleague linked it last week.
 */
function EmployeeLinkDialog({
  row,
  onClose,
  onDone,
}: {
  row: AccessRow;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [all, setAll] = React.useState<LinkableEmployee[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void employeesToLink().then((r) => {
      if (!live) return;
      if (r.ok) setAll(r.data);
      else setLoadError(r.error ?? "The employee master could not be read.");
    });
    return () => {
      live = false;
    };
  }, []);

  const shown = React.useMemo(() => {
    const rows = all ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows.slice(0, 60);
    return rows
      .filter((e) =>
        [e.name, e.employeeCode, e.email, e.phone, e.department, e.position]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, 60);
  }, [all, q]);

  const current = (all ?? []).find((e) => e.takenByUserId === row.userId) ?? null;

  const save = (employeeId: string | null) => {
    setSaving(true);
    void linkEmployee({ userId: row.userId, employeeId }).then((r) => {
      setSaving(false);
      onDone(r);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Which employee is ${row.name}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {current ? (
            <Button
              variant="secondary"
              disabled={saving}
              /* Unlinking destroys nothing — it falls back to the guess, which
                 is where the account was before anybody linked it. So it takes
                 no confirmation beyond this click. */
              title="Their pay goes back to being matched on email or work number"
              onClick={() => save(null)}
            >
              Unlink
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!chosen || saving}
            title={chosen ? undefined : "Pick an employee first"}
            onClick={() => chosen && save(chosen)}
          >
            {saving ? "Saving…" : "Link them"}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        <p>
          This is what their salary, days worked and reimbursements are read
          from — on the Sales Dashboard and on their handset, from the same
          record, so the two cannot disagree.
        </p>
        {current ? (
          <p className="mt-2">
            Linked to{" "}
            <span className="font-medium text-ink">
              {current.employeeCode} {current.name}
            </span>
            .
          </p>
        ) : row.employeeCode ? (
          <p className="mt-2">
            Nothing is linked. {row.employeeCode} is showing because their email
            or work number happened to match it — worth confirming, because on
            this book that match is usually wrong or missing.
          </p>
        ) : (
          <p className="mt-2">
            Nothing is linked and nothing matched, which is why their pay reads
            blank rather than zero.
          </p>
        )}

        <div className="mt-3">
          <Field label="Search the employee master">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, employee code, number or department"
              autoFocus
            />
          </Field>
        </div>

        {loadError ? (
          <p className="mt-3 text-danger">{loadError}</p>
        ) : all === null ? (
          <p className="mt-3 text-muted">Reading the employee master…</p>
        ) : shown.length === 0 ? (
          <p className="mt-3 text-muted">
            {q.trim()
              ? "Nobody in the master matches that."
              : "The employee master is empty. HRMS mirrors the workbook, so check the sync."}
          </p>
        ) : (
          <div className="mt-3 max-h-72 overflow-auto rounded-[4px] border border-line">
            {shown.map((e) => {
              const takenByOther = !!e.takenByUserId && e.takenByUserId !== row.userId;
              const isCurrent = e.takenByUserId === row.userId;
              return (
                <button
                  key={e.id}
                  type="button"
                  disabled={takenByOther}
                  title={
                    takenByOther
                      ? `Already linked to ${e.takenByName}. Unlink that account first — one payroll row cannot belong to two people.`
                      : undefined
                  }
                  onClick={() => setChosen(e.id)}
                  className={cx(
                    "flex w-full items-start gap-2 border-0 border-b border-line px-3 py-2 text-left last:border-b-0",
                    takenByOther
                      ? "cursor-not-allowed bg-canvas opacity-60"
                      : "cursor-pointer bg-transparent hover:bg-canvas",
                    chosen === e.id ? "bg-canvas ring-1 ring-inset ring-brand" : "",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">
                      {e.name}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {[e.employeeCode, e.position ?? e.department, e.email ?? e.phone]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {isCurrent ? <Badge tone="success">Linked</Badge> : null}
                    {takenByOther ? <Badge tone="warn">{e.takenByName}</Badge> : null}
                    {e.status === "active" ? null : (
                      <Badge tone="warn">
                        {e.status === "inactive" ? "Left" : "Status unknown"}
                      </Badge>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
