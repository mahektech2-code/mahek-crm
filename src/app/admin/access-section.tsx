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
import {
  candidatesForGrant,
  enableAccess,
  revokeApp,
  setAppModules,
} from "@/lib/actions/access";
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
 * people who work here are in HRMS, so this starts there: pick a person, pick
 * an app, and review the modules it opens.
 *
 * The module table arrives fully ticked. That is not a default so much as a
 * statement of what granting an app has always meant, and the unticking is the
 * new part: a telecaller who should not see Monthly Targets is now something
 * this screen can express.
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
  const { drawer, openDrawer, closeDrawer } = useAdmin();
  const granting = drawer?.kind === "enableAccess";
  const setGranting = (on: boolean) =>
    on ? openDrawer({ kind: "enableAccess" }) : closeDrawer();
  const [view, setView] = React.useState<View>("Everyone with access");
  const [editing, setEditing] = React.useState<null | {
    row: AccessRow;
    app: AppId;
  }>(null);
  const [revoking, setRevoking] = React.useState<null | {
    row: AccessRow;
    app: AppId;
    appName: string;
  }>(null);

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
          hint="An app grant, and how far into that app it reaches. A row saying all of them is the whole app — it stays the whole app as screens are added, which is what granting an app has always meant."
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
                ? "Every grant is the whole app. Enable access, or edit a person's modules, to withhold a screen."
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
                  <Th>App</Th>
                  <Th>Modules</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {inView.map((r, i) =>
                  r.grants.length === 0 ? (
                    <Tr key={r.userId} className={i % 2 ? "bg-canvas" : ""}>
                      <PersonCells row={r} onOpen={() => onOpenUser(r.userId)} />
                      <Td colSpan={2} className="text-muted">
                        No app — they can sign in and the launcher says so.
                      </Td>
                      <Td>
                        <span className="flex justify-end">
                          <PersonMenu
                            row={r}
                            say={say}
                            onGrant={() => setGranting(true)}
                            onOpen={() => onOpenUser(r.userId)}
                          />
                        </span>
                      </Td>
                    </Tr>
                  ) : (
                    r.grants.map((g, j) => (
                      <Tr
                        key={`${r.userId}:${g.app}`}
                        className={cx(i % 2 ? "bg-canvas" : "", j > 0 && "[&>td]:border-t-0")}
                      >
                        {j === 0 ? (
                          <PersonCells
                            row={r}
                            rowSpan={r.grants.length}
                            onOpen={() => onOpenUser(r.userId)}
                          />
                        ) : null}
                        <Td className="font-medium text-ink">{g.appName}</Td>
                        <Td>
                          <button
                            onClick={() => setEditing({ row: r, app: g.app })}
                            className="cursor-pointer border-0 bg-transparent p-0 text-sm text-body underline-offset-2 hover:underline"
                          >
                            {g.whole ? (
                              <span className="inline-flex items-center gap-2">
                                {g.totalCount === 1
                                  ? "Its one module"
                                  : `All ${g.totalCount} modules`}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-2">
                                {g.grantedCount} of {g.totalCount}
                                <Badge tone="warn">Narrowed</Badge>
                              </span>
                            )}
                          </button>
                        </Td>
                        <Td>
                          <span className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setEditing({ row: r, app: g.app })}
                            >
                              Modules
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                setRevoking({ row: r, app: g.app, appName: g.appName })
                              }
                            >
                              Revoke
                            </Button>
                            {j === 0 ? (
                              <PersonMenu
                            row={r}
                            say={say}
                            onGrant={() => setGranting(true)}
                            onOpen={() => onOpenUser(r.userId)}
                          />
                            ) : null}
                          </span>
                        </Td>
                      </Tr>
                    ))
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {granting ? (
        <EnableAccessDialog
          onClose={() => setGranting(false)}
          onDone={(r) => {
            say(r);
            setGranting(false);
          }}
        />
      ) : null}

      {editing ? (
        <ModuleDialog
          key={`${editing.row.userId}:${editing.app}`}
          row={editing.row}
          app={editing.app}
          onClose={() => setEditing(null)}
          onDone={(r) => {
            say(r);
            setEditing(null);
          }}
        />
      ) : null}

      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Take the app away"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!revoking) return;
                const { row, app } = revoking;
                setRevoking(null);
                void revokeApp(row.userId, app).then(say);
              }}
            >
              Revoke it
            </Button>
          </>
        }
      >
        {revoking ? (
          <div className="text-sm leading-[21px] text-body">
            {revoking.row.name} will no longer open {revoking.appName}, and a bookmarked link
            into it will send them back to the launcher. Which modules they had is forgotten
            with the grant, so granting it back starts from the whole app.
            {revoking.row.grants.length === 1 ? (
              <p className="mt-2">
                It is their only app. They will still be able to sign in, onto a launcher that
                says plainly that they have nothing.
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function PersonCells({
  row,
  rowSpan,
  onOpen,
}: {
  row: AccessRow;
  rowSpan?: number;
  onOpen: () => void;
}) {
  return (
    <>
      <Td rowSpan={rowSpan} className="align-top font-medium text-ink">
        <button
          onClick={onOpen}
          className="cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-ink underline-offset-2 hover:underline"
        >
          {row.name}
        </button>
        <span className="block text-[13px] font-normal text-muted">{row.email}</span>
        {!row.active ? <Badge tone="neutral">Deactivated</Badge> : null}
      </Td>
      <Td rowSpan={rowSpan} className="align-top capitalize">
        {row.role}
      </Td>
      <Td rowSpan={rowSpan} className="align-top">
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
  onGrant,
  onOpen,
}: {
  row: AccessRow;
  say: (r: { ok: boolean; message?: string; error?: string }) => void;
  onGrant: () => void;
  onOpen: () => void;
}) {
  return (
    <RowMenu
      items={[
        { label: "Enable another app", onSelect: onGrant },
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

/* ------------------------------------------------------------ enable access */

type Step = "who" | "app" | "modules";

function EnableAccessDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [step, setStep] = React.useState<Step>("who");
  const [people, setPeople] = React.useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [chosen, setChosen] = React.useState<Candidate | null>(null);
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [role, setRole] = React.useState<(typeof ROLES)[number]["id"]>("telecaller");
  const [app, setApp] = React.useState<AppId | null>(null);
  const [ticked, setTicked] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<Record<string, string>>({});

  // Read on open rather than passed down with the page: somebody who has just
  // been added to the employee sheet and synced is pickable without a reload.
  //
  // The effect starts the read and nothing else — the state lands in the
  // promise's callback, which is what keeps it out of the render path the
  // React Compiler rules are about.
  const [reload, setReload] = React.useState(0);
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

  const refresh = () => {
    setPeople(null);
    setLoadError(null);
    setReload((n) => n + 1);
  };

  const matches = (people ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.email, c.phone, c.employeeCode, c.department, c.position]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  const pick = (c: Candidate) => {
    setChosen(c);
    setEmail(c.email ?? "");
    setPhone(c.phone ?? "");
    setFieldError({});
    setStep("app");
  };

  const chooseApp = (id: AppId) => {
    setApp(id);
    // Every module ticked. Unticking is the decision; ticking is the default,
    // because an app has always meant all of it.
    setTicked(modulesForApp(id).map((m) => m.key));
    setStep("modules");
  };

  const submit = () => {
    if (!chosen || !app) return;
    setSaving(true);
    setFieldError({});
    void enableAccess({
      userId: chosen.userId,
      employeeId: chosen.employeeId,
      app,
      modules: ticked,
      account: chosen.userId
        ? undefined
        : { email: email.trim(), phone: phone.trim() || null, role },
    }).then((r) => {
      setSaving(false);
      if (!r.ok && r.fieldErrors?.length) {
        setFieldError(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
        return;
      }
      onDone(r);
    });
  };

  const needsAccount = !!chosen && !chosen.userId;
  const already = chosen && app ? chosen.apps.includes(app) : false;

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title={
        step === "who"
          ? "Enable access — who"
          : step === "app"
            ? `Enable access — which app for ${chosen?.name}`
            : `Enable access — what ${chosen?.name} opens inside it`
      }
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() =>
              step === "who" ? onClose() : setStep(step === "modules" ? "app" : "who")
            }
          >
            {step === "who" ? "Cancel" : "Back"}
          </Button>
          {step === "modules" ? (
            <Button
              variant="primary"
              disabled={saving || ticked.length === 0}
              title={ticked.length === 0 ? "Leave at least one module ticked" : undefined}
              onClick={submit}
            >
              {saving ? "Saving…" : already ? "Update access" : "Enable access"}
            </Button>
          ) : null}
        </>
      }
    >
      {step === "who" ? (
        <div>
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder="Search the employee master and the accounts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button size="sm" variant="secondary" onClick={refresh}>
              Refresh
            </Button>
          </div>
          <p className="mt-2 text-[13px] leading-[19px] text-muted">
            Everybody HRMS knows about, and every account that exists. Only somebody active
            in HRMS can be given access — a leaver is listed with the reason rather than
            hidden, because a person missing from a search box reads as a broken search box.
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
                  onClick={() => pick(c)}
                  className={cx(
                    "flex w-full items-center gap-3 border-0 border-b border-divider bg-transparent px-3 py-2.5 text-left last:border-b-0",
                    c.blocked
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer hover:bg-canvas",
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
      ) : step === "app" ? (
        <div>
          {needsAccount ? (
            <div className="mb-4 rounded-[4px] border border-line bg-canvas p-3.5">
              <div className="text-sm font-medium text-ink">
                {chosen?.name} has no MahekOne account yet
              </div>
              <p className="mt-0.5 text-[13px] leading-[19px] text-muted">
                One is created when you finish. No password is typed here — they get a link
                to choose their own, which works once and expires in thirty minutes.
              </p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <Field label="Sign-in email" error={fieldError.email}>
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Work number" error={fieldError.phone} hint="Optional. Also a sign-in.">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Field>
                <Field label="Role" hint="What they can DO, app by app aside.">
                  <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
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

          <div className="rounded-[4px] border border-line">
            {APPS.map((a) => {
              const held = chosen?.apps.includes(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => chooseApp(a.id)}
                  className="flex w-full cursor-pointer items-center gap-3 border-0 border-b border-divider bg-transparent px-3 py-2.5 text-left last:border-b-0 hover:bg-canvas"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{a.name}</span>
                    <span className="block text-[13px] text-muted">{a.description}</span>
                  </span>
                  {a.built ? null : <Badge tone="neutral">Not built yet</Badge>}
                  {held ? <Badge tone="success">Already has it</Badge> : null}
                  <span className="text-[13px] text-muted">
                    {modulesForApp(a.id).length} module
                    {modulesForApp(a.id).length === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : app ? (
        <ModuleReview
          app={app}
          ticked={ticked}
          onChange={setTicked}
          note={
            already
              ? `${chosen?.name} already opens this app. Saving replaces what they hold with what is ticked here.`
              : undefined
          }
          error={fieldError.modules}
        />
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------- editing modules in place */

function ModuleDialog({
  row,
  app,
  onClose,
  onDone,
}: {
  row: AccessRow;
  app: AppId;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const grant = row.grants.find((g) => g.app === app)!;
  // Initial state from a prop, and the dialog is keyed on the person and the
  // app — no effect resets it when they change, it simply remounts.
  const [ticked, setTicked] = React.useState<string[]>(
    grant.modules.filter((m) => m.granted).map((m) => m.key),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title={`${row.name} · ${grant.appName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving || ticked.length === 0}
            title={ticked.length === 0 ? "Leave at least one module ticked" : undefined}
            onClick={() => {
              setSaving(true);
              setError(null);
              void setAppModules(row.userId, app, ticked).then((r) => {
                setSaving(false);
                if (!r.ok && r.fieldErrors?.length) {
                  setError(r.fieldErrors[0].message);
                  return;
                }
                onDone(r);
              });
            }}
          >
            {saving ? "Saving…" : "Save modules"}
          </Button>
        </>
      }
    >
      <ModuleReview app={app} ticked={ticked} onChange={setTicked} error={error} />
    </Modal>
  );
}

/* ----------------------------------------------------- the review table itself */

function ModuleReview({
  app,
  ticked,
  onChange,
  note,
  error,
}: {
  app: AppId;
  ticked: string[];
  onChange: (next: string[]) => void;
  note?: string;
  error?: string | null;
}) {
  const groups = moduleGroupsForApp(app);
  const all = modulesForApp(app).map((m) => m.key);
  const whole = ticked.length >= all.length;

  const toggle = (key: string) =>
    onChange(ticked.includes(key) ? ticked.filter((k) => k !== key) : [...ticked, key]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-body">
          {whole ? (
            all.length === 1 ? (
              <>Its one module. This is the whole app.</>
            ) : (
              <>All {all.length} modules. This is the whole app.</>
            )
          ) : (
            <>
              {ticked.length} of {all.length} modules. The rest are not drawn in their
              navigation, and a bookmarked link into one sends them to the first module
              they do hold.
            </>
          )}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => onChange(all)}>
          Tick all
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onChange([])}>
          Untick all
        </Button>
      </div>

      {note ? <p className="mt-2 text-[13px] text-muted">{note}</p> : null}
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-3 overflow-hidden rounded-[4px] border border-line">
        <table className="w-full">
          <thead>
            <tr>
              <Th className="w-11" />
              <Th>Module</Th>
              <Th>What withholding it costs</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.group}>
                <tr>
                  <Td
                    colSpan={3}
                    className="bg-canvas text-[11px] font-medium tracking-[0.04em] text-muted uppercase"
                  >
                    {g.group}
                  </Td>
                </tr>
                {g.modules.map((m) => (
                  <Tr key={m.key}>
                    <Td className="w-11">
                      <Checkbox
                        label=""
                        aria-label={m.label}
                        checked={ticked.includes(m.key)}
                        onChange={() => toggle(m.key)}
                      />
                    </Td>
                    <Td className="font-medium text-ink">{m.label}</Td>
                    <Td className="text-muted">{m.note ?? "—"}</Td>
                  </Tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
