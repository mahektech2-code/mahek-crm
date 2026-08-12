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
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { FilterPills, Modal, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { grantableApps, moduleGroupsForApp, modulesForApp } from "@/lib/modules";
import type { AppId } from "@/lib/apps";
import { candidatesForGrant, setAccess } from "@/lib/actions/access";
import { endSessionsFor, sendPasswordResetFor } from "@/lib/actions/people";
import type { AccessRow, Candidate } from "@/lib/services/access-service";
import { useAdmin } from "./store";

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

const ROLES = [
  { id: "telecaller", label: "Telecaller" },
  { id: "manager", label: "Manager" },
  { id: "accounts", label: "Accounts" },
  { id: "admin", label: "Admin" },
] as const;

const VIEWS = [
  "Everyone with access",
  "Narrowed access",
  "No app at all",
  "Deactivated",
] as const;
type View = (typeof VIEWS)[number];

/** The desired state while the dialog is open: app → the modules ticked. */
type Draft = Record<string, string[]>;

const ALL_OF = (app: AppId) => modulesForApp(app).map((m) => m.key);

export function AccessSection({
  rows,
  onOpenUser,
}: {
  rows: AccessRow[];
  /** The account's own record — deactivation, identity, notes still live there. */
  onOpenUser: (id: string) => void;
}) {
  const router = useRouter();
  const { push } = useToast();
  // The Enable access button sits in the console's header beside the section
  // title, where every other section's primary action lives. It opens this
  // through the same store the rest of the console opens its editors with,
  // rather than the shell reaching into this file.
  const { drawer, closeDrawer } = useAdmin();
  const [view, setView] = React.useState<View>("Everyone with access");
  /** Managing somebody already on the list skips the picker. */
  const [managing, setManaging] = React.useState<AccessRow | null>(null);

  const say = (r: { ok: boolean; message?: string; error?: string }) => {
    push(r.ok ? (r.message ?? "Saved.") : (r.error ?? "That did not work."));
    if (r.ok) router.refresh();
  };

  const inView = rows.filter((r) => {
    if (view === "Deactivated") return !r.active;
    if (!r.active) return false;
    if (view === "No app at all") return r.grants.length === 0;
    if (view === "Narrowed access") return r.grants.some((g) => !g.whole);
    return r.grants.length > 0;
  });

  const withAccess = rows.filter((r) => r.active && r.grants.length > 0).length;
  const narrowed = rows.filter((r) => r.grants.some((g) => !g.whole)).length;

  return (
    <div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <FilterPills
          options={VIEWS.map((v) => ({ key: v, label: v }))}
          value={view}
          onChange={setView}
        />
        <span className="flex-1" />
        <span className="text-[13px] whitespace-nowrap text-muted">
          {withAccess} with access · {narrowed} narrowed
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
                  : "Nobody here"
            }
            body={
              view === "Narrowed access"
                ? "Every grant is the whole app. Manage somebody's access to withhold a screen."
                : "Nothing matches this view."
            }
          />
        ) : (
          <div className="overflow-auto">
            <table className="[&_td]:whitespace-nowrap">
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Role</Th>
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
                          No app — they can sign in and the launcher says so.
                        </span>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          {r.grants.map((g) => (
                            <span key={g.app} className="inline-flex items-center gap-2">
                              <span className="min-w-[9rem] font-medium text-ink">
                                {g.appName}
                              </span>
                              <span className="text-muted">
                                {g.whole
                                  ? g.totalCount === 1
                                    ? "its one module"
                                    : `all ${g.totalCount} modules`
                                  : `${g.grantedCount} of ${g.totalCount}`}
                              </span>
                              {g.whole ? null : <Badge tone="warn">Narrowed</Badge>}
                            </span>
                          ))}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="flex justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => setManaging(r)}>
                          Manage access
                        </Button>
                        <PersonMenu
                          row={r}
                          say={say}
                          onManage={() => setManaging(r)}
                          onOpen={() => onOpenUser(r.userId)}
                        />
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Enabling access for somebody new: the picker comes first. */}
      {drawer?.kind === "enableAccess" ? (
        <AccessDialog
          onClose={closeDrawer}
          onDone={(r) => {
            say(r);
            closeDrawer();
          }}
        />
      ) : null}

      {/* Managing somebody already on the list: straight to the apps. Keyed on
          the person, so the draft is initial state on a fresh mount rather than
          something an effect has to reset. */}
      {managing ? (
        <AccessDialog
          key={managing.userId}
          person={managing}
          onClose={() => setManaging(null)}
          onDone={(r) => {
            say(r);
            setManaging(null);
          }}
        />
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
          className="cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-ink underline-offset-2 hover:underline"
        >
          {row.name}
        </button>
        <span className="block text-[13px] font-normal text-muted">{row.email}</span>
        {!row.active ? <Badge tone="neutral">Deactivated</Badge> : null}
      </Td>
      <Td className="align-top capitalize">{row.role}</Td>
      <Td className="align-top">
        {row.employeeCode ? (
          <span className="inline-flex items-center gap-2">
            {row.employeeCode}
            {row.employeeStatus === "active" ? null : (
              <Badge tone="warn">
                {row.employeeStatus === "inactive" ? "Left" : "Status unknown"}
              </Badge>
            )}
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
  onOpen,
}: {
  row: AccessRow;
  say: (r: { ok: boolean; message?: string; error?: string }) => void;
  onManage: () => void;
  onOpen: () => void;
}) {
  return (
    <RowMenu
      items={[
        { label: "Manage access", onSelect: onManage },
        { label: "Open their record", onSelect: onOpen },
        {
          label: "Send a password reset link",
          onSelect: () => void sendPasswordResetFor(row.userId).then(say),
        },
        {
          label: "End every session",
          onSelect: () => void endSessionsFor(row.userId).then(say),
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------- the dialog */

type Step = "who" | "access" | "review";

function AccessDialog({
  person,
  onClose,
  onDone,
}: {
  /** Somebody already on the list. Absent means start from the picker. */
  person?: AccessRow;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [step, setStep] = React.useState<Step>(person ? "access" : "who");
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
  const before: Draft = React.useMemo(() => {
    const out: Draft = {};
    for (const g of person?.grants ?? []) {
      out[g.app] = g.modules.filter((m) => m.granted).map((m) => m.key);
    }
    return out;
  }, [person]);

  const [draft, setDraft] = React.useState<Draft>(before);
  const [email, setEmail] = React.useState(person?.email ?? "");
  const [phone, setPhone] = React.useState(person?.phone ?? "");
  const [role, setRole] = React.useState<(typeof ROLES)[number]["id"]>("telecaller");
  const [saving, setSaving] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<Record<string, string>>({});

  const needsAccount = !!chosen && !chosen.userId;

  const pick = (c: Candidate) => {
    setChosen(c);
    setEmail(c.email ?? "");
    setPhone(c.phone ?? "");
    // Somebody already holding apps arrives with what they hold, not empty —
    // this dialog sets the whole picture, so it has to start from the picture.
    setDraft(Object.fromEntries(c.apps.map((a) => [a, ALL_OF(a)])));
    setFieldError({});
    setStep("access");
  };

  const submit = () => {
    if (!chosen) return;
    setSaving(true);
    setFieldError({});
    void setAccess({
      userId: chosen.userId,
      employeeId: chosen.employeeId,
      grants: Object.entries(draft).map(([app, modules]) => ({ app, modules })),
      account: chosen.userId
        ? undefined
        : { email: email.trim(), phone: phone.trim() || null, role },
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
      onDone(r);
    });
  };

  const changes = describeChanges(before, draft);

  return (
    <Modal
      open
      onClose={onClose}
      width={880}
      title={
        step === "who"
          ? "Enable access — who"
          : step === "access"
            ? `What ${chosen?.name} can open`
            : `Review — ${chosen?.name}`
      }
      footer={
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
          role={role}
          onEmail={setEmail}
          onPhone={setPhone}
          onRole={setRole}
          draft={draft}
          onDraft={setDraft}
          fieldError={fieldError}
        />
      ) : (
        <ReviewStep
          name={chosen?.name ?? ""}
          creating={needsAccount}
          email={email}
          role={role}
          changes={changes}
          draft={draft}
        />
      )}
    </Modal>
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
      <p className="mt-2 text-[13px] leading-[19px] text-muted">
        Everybody HRMS knows about, and every account that exists. Only somebody active in
        HRMS can be given access — a leaver is listed with the reason rather than hidden,
        because a person missing from a search box reads as a broken search box.
      </p>

      {loadError ? (
        <p className="mt-4 text-sm text-danger">{loadError}</p>
      ) : people === null ? (
        <p className="mt-4 text-sm text-muted">Reading the employee master…</p>
      ) : matches.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Nobody matches “{query}”.</p>
      ) : (
        <div className="mt-3 max-h-[46vh] overflow-auto rounded-[4px] border border-line">
          {matches.map((c) => (
            <button
              key={c.employeeId ?? c.userId}
              disabled={!!c.blocked}
              title={c.blocked ?? undefined}
              onClick={() => onPick(c)}
              className={cx(
                "flex w-full items-center gap-3 border-0 border-b border-divider bg-transparent px-3 py-2.5 text-left last:border-b-0",
                c.blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-canvas",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{c.name}</span>
                <span className="block text-[13px] text-muted">
                  {[c.employeeCode, c.position ?? c.department, c.email ?? c.phone]
                    .filter(Boolean)
                    .join(" · ") || "No contact details on file"}
                </span>
              </span>
              {c.blocked ? (
                <span className="text-[13px] text-muted">{c.blocked}</span>
              ) : (
                <>
                  {c.userId ? null : <Badge tone="brand">No account yet</Badge>}
                  {c.employeeStatus === null ? <Badge tone="neutral">Not in HRMS</Badge> : null}
                  {c.apps.length ? (
                    <span className="text-[13px] text-muted">
                      {c.apps.length} app{c.apps.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
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
 */
function AccessStep({
  needsAccount,
  name,
  email,
  phone,
  role,
  onEmail,
  onPhone,
  onRole,
  draft,
  onDraft,
  fieldError,
}: {
  needsAccount: boolean;
  name: string;
  email: string;
  phone: string;
  role: (typeof ROLES)[number]["id"];
  onEmail: (v: string) => void;
  onPhone: (v: string) => void;
  onRole: (v: (typeof ROLES)[number]["id"]) => void;
  draft: Draft;
  onDraft: (next: Draft) => void;
  fieldError: Record<string, string>;
}) {
  const setApp = (app: AppId, modules: string[]) => {
    const next = { ...draft };
    if (modules.length) next[app] = modules;
    else delete next[app];
    onDraft(next);
  };

  const granted = Object.keys(draft).length;

  return (
    <div>
      {needsAccount ? (
        <div className="mb-4 rounded-[4px] border border-line bg-canvas p-3.5">
          <div className="text-sm font-medium text-ink">{name} has no MahekOne account yet</div>
          <p className="mt-0.5 text-[13px] leading-[19px] text-muted">
            One is created when you grant access. No password is typed here — they get a
            link to choose their own, which works once and expires in thirty minutes.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label="Sign-in email" error={fieldError.email}>
              <Input value={email} onChange={(e) => onEmail(e.target.value)} />
            </Field>
            <Field label="Work number" error={fieldError.phone} hint="Optional. Also a sign-in.">
              <Input value={phone} onChange={(e) => onPhone(e.target.value)} />
            </Field>
            <Field label="Role" hint="What they can DO, app by app aside.">
              <Select value={role} onChange={(e) => onRole(e.target.value as typeof role)}>
                {ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-body">
          Tick an app to grant it, and untick the screens inside it they should not open.
        </span>
        <span className="flex-1" />
        <span className="text-[13px] whitespace-nowrap text-muted">
          {granted} app{granted === 1 ? "" : "s"}
        </span>
      </div>
      {fieldError.grants ? (
        <p className="mt-2 text-[13px] text-danger">{fieldError.grants}</p>
      ) : null}

      <div className="mt-3 flex flex-col gap-2.5">
        {APPS.map((app) => (
          <AppBlock
            key={app.id}
            app={app.id}
            name={app.name}
            description={app.description}
            built={app.built}
            ticked={draft[app.id] ?? []}
            onChange={(modules) => setApp(app.id, modules)}
          />
        ))}
      </div>
    </div>
  );
}

function AppBlock({
  app,
  name,
  description,
  built,
  ticked,
  onChange,
}: {
  app: AppId;
  name: string;
  description: string;
  built: boolean;
  ticked: string[];
  onChange: (modules: string[]) => void;
}) {
  const all = ALL_OF(app);
  const groups = moduleGroupsForApp(app);
  const on = ticked.length > 0;
  const whole = ticked.length >= all.length;

  return (
    <div
      className={cx(
        "overflow-hidden rounded-[4px] border",
        on ? "border-brand-softer" : "border-line",
      )}
    >
      <div className={cx("flex items-center gap-3 px-3.5 py-2.5", on ? "bg-brand-soft" : "")}>
        <Checkbox
          checked={on}
          aria-label={name}
          onChange={() => onChange(on ? [] : all)}
          label={
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">{name}</span>
              <span className="block text-[13px] text-muted">{description}</span>
            </span>
          }
        />
        <span className="flex-1" />
        {built ? null : <Badge tone="neutral">Not built yet</Badge>}
        <span className="text-[13px] whitespace-nowrap text-muted">
          {!on
            ? `${all.length} module${all.length === 1 ? "" : "s"}`
            : whole
              ? all.length === 1
                ? "its one module"
                : `all ${all.length} modules`
              : `${ticked.length} of ${all.length}`}
        </span>
        {on && !whole ? <Badge tone="warn">Narrowed</Badge> : null}
      </div>

      {/* The modules appear once the app is ticked. Drawing forty checkboxes
          nobody can act on would bury the seven decisions that matter. */}
      {on ? (
        <div className="border-t border-divider bg-surface px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] leading-[19px] text-muted">
              Untick a screen to withhold it. It is not drawn in their navigation, and a
              bookmarked link into it sends them to the first screen they do hold.
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              disabled={whole}
              title={whole ? "Every screen is already ticked" : undefined}
              onClick={() => onChange(all)}
            >
              Tick all
            </Button>
          </div>
          {groups.map((g) => (
            <div key={g.group} className="mt-2.5">
              <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                {g.group}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {g.modules.map((m) => (
                  <Checkbox
                    key={m.key}
                    checked={ticked.includes(m.key)}
                    // What withholding it costs rides on the title rather than
                    // in the layout: forty sentences on one page is clutter
                    // rather than help, the same trade the microphone's own
                    // guidance makes.
                    title={m.note}
                    onChange={() =>
                      onChange(
                        ticked.includes(m.key)
                          ? ticked.filter((k) => k !== m.key)
                          : [...ticked, m.key],
                      )
                    }
                    label={<span className="text-sm text-body">{m.label}</span>}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- step three */

type Changes = {
  granted: AppId[];
  revoked: AppId[];
  narrowed: AppId[];
  widened: AppId[];
  unchanged: AppId[];
  any: boolean;
};

function describeChanges(before: Draft, after: Draft): Changes {
  const beforeApps = Object.keys(before) as AppId[];
  const afterApps = Object.keys(after) as AppId[];

  const granted = afterApps.filter((a) => !beforeApps.includes(a));
  const revoked = beforeApps.filter((a) => !afterApps.includes(a));
  const narrowed: AppId[] = [];
  const widened: AppId[] = [];
  const unchanged: AppId[] = [];

  for (const a of afterApps.filter((x) => beforeApps.includes(x))) {
    const was = before[a] ?? [];
    const now = after[a] ?? [];
    if (was.length === now.length && now.every((m) => was.includes(m))) unchanged.push(a);
    else if (now.length < was.length) narrowed.push(a);
    else widened.push(a);
  }

  return {
    granted,
    revoked,
    narrowed,
    widened,
    unchanged,
    any: granted.length + revoked.length + narrowed.length + widened.length > 0,
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
  role,
  changes,
  draft,
}: {
  name: string;
  creating: boolean;
  email: string;
  role: string;
  changes: Changes;
  draft: Draft;
}) {
  const appName = (id: AppId) => APPS.find((a) => a.id === id)?.name ?? id;
  const scope = (id: AppId) => {
    const n = (draft[id] ?? []).length;
    const total = ALL_OF(id).length;
    return n >= total
      ? total === 1
        ? "its one module"
        : `all ${total} modules`
      : `${n} of ${total} modules`;
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
            what: "A new MahekOne account",
            detail: `${name} signs in with ${email} as a ${role}. A link to choose a password is emailed to them; no password is set here.`,
          },
        ]
      : []),
    ...changes.granted.map((a) => ({
      key: `g:${a}`,
      tone: "success" as const,
      tag: "Grant",
      what: `${appName(a)} — granted`,
      detail: scope(a),
    })),
    ...changes.widened.map((a) => ({
      key: `w:${a}`,
      tone: "success" as const,
      tag: "Widen",
      what: `${appName(a)} — widened`,
      detail: scope(a),
    })),
    ...changes.narrowed.map((a) => ({
      key: `n:${a}`,
      tone: "warn" as const,
      tag: "Narrow",
      what: `${appName(a)} — narrowed`,
      detail: `${scope(a)}. The rest disappear from their navigation.`,
    })),
    ...changes.revoked.map((a) => ({
      key: `r:${a}`,
      tone: "danger" as const,
      tag: "Revoke",
      what: `${appName(a)} — taken away`,
      detail:
        "They stop opening it, and a bookmarked link sends them back to the launcher. Which modules they had is forgotten with the grant.",
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
                "flex items-start gap-3 px-3.5 py-3",
                i ? "border-t border-divider" : "",
              )}
            >
              <Badge tone={r.tone}>{r.tag}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{r.what}</span>
                <span className="block text-[13px] leading-[19px] text-muted">{r.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {changes.unchanged.length ? (
        <p className="mt-3 text-[13px] text-muted">
          Unchanged: {changes.unchanged.map(appName).join(", ")}.
        </p>
      ) : null}

      {changes.any && Object.keys(draft).length === 0 ? (
        <p className="mt-3 text-[13px] leading-[19px] text-warn-ink">
          This leaves {name} with no app at all. They can still sign in, onto a launcher that
          says so plainly rather than a blank screen.
        </p>
      ) : null}
    </div>
  );
}
