"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Select,
  Td,
  Th,
  Tr,
  cx,
  type Tone,
} from "@/components/ui/primitives";
import { FilterPills, Modal, RowMenu, SelectionBar } from "@/components/ui/overlays";
import { LEAVER_CHECKLIST } from "./data-platform";
import {
  CHECKLIST,
  RESETS,
  ROLE_TEMPLATES,
  SECURITY_FLAGS,
  SECURITY_POLICY,
  SIGNINS,
  TEAMS,
  ownedFor,
  type AdminUser,
  type UserStatus,
} from "./data";
import { useAdmin } from "./store";

export function statusTone(status: UserStatus): Tone {
  return status === "Active"
    ? "success"
    : status === "Invited"
      ? "brand"
      : status === "Locked"
        ? "danger"
        : "neutral";
}

const VIEWS = [
  "All active",
  "Invited, never signed in",
  "No activity in 30 days",
  "Single-app users",
  "Managers",
  "Deactivated",
] as const;
type View = (typeof VIEWS)[number];

export function PeopleSection({
  tab,
  onOpenUser,
}: {
  tab: number;
  onOpenUser: (id: string) => void;
}) {
  if (tab === 0) return <Roster onOpenUser={onOpenUser} />;
  if (tab === 1) return <AppAccess />;
  if (tab === 2) return <RolesAndTeams />;
  if (tab === 3) return <SessionsAndSecurity />;
  return <Onboarding />;
}

/* ------------------------------------------------------------------ roster */

function Roster({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const { users, registry, notify, openDrawer } = useAdmin();
  const [view, setView] = React.useState<View>("All active");
  const [selected, setSelected] = React.useState<string[]>([]);

  const inView = users.filter((u) => {
    if (view === "All active") return u.status !== "Deactivated";
    if (view === "Invited, never signed in") return u.status === "Invited";
    if (view === "No activity in 30 days") return u.lastActive === "—" || u.status === "Deactivated";
    if (view === "Single-app users") return u.apps.length === 1;
    if (view === "Managers") return Object.values(u.roles).includes("Manager");
    return u.status === "Deactivated";
  });

  const bulk = (label: string, message: string) => (
    <Button
      key={label}
      size="sm"
      variant="dark"
      onClick={() => {
        notify(message.replace("{n}", String(selected.length)));
        setSelected([]);
      }}
    >
      {label}
    </Button>
  );

  return (
    <div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <FilterPills
          options={VIEWS.map((v) => ({ key: v, label: v }))}
          value={view}
          onChange={(v) => {
            setView(v);
            setSelected([]);
          }}
        />
        <span className="flex-1" />
        <span className="text-[13px] whitespace-nowrap text-muted">
          {inView.length} of {users.length} users
        </span>
      </div>

      <SelectionBar count={selected.length} onClear={() => setSelected([])}>
        {bulk("Grant an app", "App granted to {n} users")}
        {bulk("Assign a role", "Role assigned to {n} users")}
        {bulk("Trigger password reset", "Reset links sent to {n} users")}
        {bulk("Force sign-out", "Sessions ended for {n} users")}
        {bulk("Export", "{n} users exported")}
      </SelectionBar>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th />
                <Th>Name</Th>
                <Th>Code</Th>
                <Th>Team</Th>
                <Th>Reports to</Th>
                <Th>Status</Th>
                <Th>Apps</Th>
                <Th>Roles</Th>
                <Th align="right">Owns</Th>
                <Th>Last active</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {inView.map((u, i) => {
                const on = selected.includes(u.id);
                const owns = ownedFor(u.id).reduce((a, r) => a + r.count, 0);
                return (
                  <Tr
                    key={u.id}
                    onClick={() => onOpenUser(u.id)}
                    className={cx("cursor-pointer", on ? "bg-brand-soft" : i % 2 ? "bg-canvas" : "")}
                  >
                    <Td>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          label=""
                          checked={on}
                          aria-label={`Select ${u.name}`}
                          onChange={() =>
                            setSelected((s) => (on ? s.filter((x) => x !== u.id) : [...s, u.id]))
                          }
                        />
                      </span>
                    </Td>
                    <Td className="font-medium text-ink">{u.name}</Td>
                    <Td>{u.code}</Td>
                    <Td>{u.dept}</Td>
                    <Td>{u.reportsTo ?? "—"}</Td>
                    <Td>
                      <Badge tone={statusTone(u.status)}>{u.status}</Badge>
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-2">
                        {u.apps.length
                          ? u.apps.map((id) => registry.find((a) => a.id === id)?.short).join(", ")
                          : "None"}
                        {u.apps.length === 1 ? <Badge tone="brand">Single app</Badge> : null}
                      </span>
                    </Td>
                    <Td>
                      {Object.keys(u.roles).length
                        ? Object.entries(u.roles)
                            .map(([k, v]) => `${registry.find((a) => a.id === k)?.short}: ${v}`)
                            .join(" · ")
                        : "—"}
                    </Td>
                    <Td align="right">{owns ? owns : "—"}</Td>
                    <Td>{u.lastActive}</Td>
                    <Td>{u.created}</Td>
                    <Td>
                      <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <RowMenu
                          items={[
                            { label: "Edit user", onSelect: () => openDrawer({ kind: "editUser", id: u.id }) },
                            {
                              label: "Trigger password reset",
                              onSelect: () =>
                                notify(`Reset link sent to ${u.contact} — it expires in 30 minutes and kills any earlier one`),
                            },
                            { label: "Force sign-out", onSelect: () => notify(`All sessions ended for ${u.name}`) },
                            {
                              label: u.status === "Active" ? "Deactivate user" : "Already deactivated",
                              destructive: u.status === "Active",
                              disabled: u.status !== "Active",
                              title: u.status !== "Active" ? "This account is not active" : undefined,
                              onSelect: () => onOpenUser(u.id),
                            },
                          ]}
                        />
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- app access */

function AppAccess() {
  const {
    users,
    registry,
    requests,
    expiring,
    unused,
    toggleAppAccess,
    resolveRequest,
    endExpiring,
    revokeUnused,
    notify,
  } = useAdmin();
  const [pending, setPending] = React.useState<null | {
    userId: string; userName: string; appId: string; appName: string; grows: boolean; other: string;
  }>(null);

  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="App access"
          hint="This grid drives the launcher. Granting a second app changes that person's whole sign-in — they stop going straight into one app."
          action={
            <Button size="sm" variant="ghost" onClick={() => notify("Access matrix exported")}>
              Export the matrix
            </Button>
          }
        />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>User</Th>
                {registry.map((a) => (
                  <Th key={a.id}>
                    {a.short}{" "}
                    <span className="text-line-strong">
                      {users.filter((u) => u.apps.includes(a.id)).length}
                    </span>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users
                .filter((u) => u.status !== "Deactivated")
                .map((u, i) => (
                  <Tr key={u.id} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">
                      <span className="inline-flex items-center gap-2">
                        {u.name}
                        {u.apps.length === 1 ? <Badge tone="brand">Single app</Badge> : null}
                      </span>
                    </Td>
                    {registry.map((a) => (
                      <Td key={a.id}>
                        <Checkbox
                          label=""
                          aria-label={`${a.name} access for ${u.name}`}
                          checked={u.apps.includes(a.id)}
                          onChange={() => {
                            const had = u.apps.includes(a.id);
                            const after = had ? u.apps.length - 1 : u.apps.length + 1;
                            // Crossing one app either way changes where this
                            // person lands at sign-in, which is a bigger change
                            // than the checkbox looks.
                            if ((u.apps.length === 1 && after === 2) || (u.apps.length === 2 && after === 1)) {
                              setPending({ userId: u.id, userName: u.name, appId: a.id, appName: a.name, grows: !had, other: registry.find((x) => x.id === (had ? u.apps.find((z) => z !== a.id) : u.apps[0]))?.name ?? "" });
                              return;
                            }
                            toggleAppAccess(u.id, a.id);
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

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Access requests"
          hint="The launcher's locked chips have a request action. Those requests land here."
        />
        {requests.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">No outstanding requests.</div>
        ) : null}
        {requests.map((r, i) => (
          <div
            key={r.id}
            className={cx(
              "flex items-start gap-4 border-l-[3px] border-l-warn px-5 py-3.5",
              i ? "border-t border-t-canvas" : "",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">
                {r.user} · {r.app}
              </span>
              <span className="mt-0.5 block text-[13px] leading-[19px] text-body">{r.why}</span>
              <span className="mt-0.5 block text-xs text-muted">{r.on}</span>
            </span>
            <span className="flex flex-none gap-2">
              <Button size="sm" variant="ghost" onClick={() => resolveRequest(r.id, false)}>
                Decline
              </Button>
              <Button size="sm" variant="primary" onClick={() => resolveRequest(r.id, true)}>
                Approve
              </Button>
            </span>
          </div>
        ))}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Expiring access" hint="So nothing quietly becomes permanent." />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Who</Th>
                <Th>App</Th>
                <Th>Why</Th>
                <Th>Ends</Th>
                <Th>Remaining</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {expiring.map((r, i) => (
                <Tr key={`${r.who}-${r.app}`} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{r.who}</Td>
                  <Td>{r.app}</Td>
                  <Td>{r.kind}</Td>
                  <Td>{r.ends}</Td>
                  <Td className={cx("font-medium", r.left < 20 ? "text-warn-ink" : "text-body")}>
                    {r.left} {r.left === 1 ? "day" : "days"} left
                  </Td>
                  <Td>
                    <span className="flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => notify("Extended by 30 days")}>
                        Extend
                      </Button>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => endExpiring(i)}>
                        End now
                      </Button>
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Unused access"
          hint="Granted but never opened. This is how access sprawl gets cleaned up."
        />
        {unused.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">Every granted app has been opened.</div>
        ) : (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>Who</Th>
                  <Th>App</Th>
                  <Th>Granted</Th>
                  <Th>Last opened</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {unused.map((r, i) => (
                  <Tr key={`${r.who}-${r.app}`} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">{r.who}</Td>
                    <Td>{r.app}</Td>
                    <Td>{r.granted}</Td>
                    <Td>{r.opened}</Td>
                    <Td>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => revokeUnused(i)}>
                        Revoke
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title="This changes how they sign in"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (pending) toggleAppAccess(pending.userId, pending.appId);
                setPending(null);
              }}
            >
              {pending?.grows ? "Grant it anyway" : "Revoke it"}
            </Button>
          </>
        }
      >
        {pending ? (
          <div className="text-sm leading-[21px] text-body">
            {pending.grows ? (
              <>
                {pending.userName} opens only {pending.other} today, so MahekOne takes them straight into it and hides
                the app switcher. Granting {pending.appName} means they land on the launcher every morning instead, and
                have to choose.
              </>
            ) : (
              <>
                {pending.userName} would be left with one app. MahekOne will stop showing them the launcher and take
                them straight into it — a single option is not a choice.
              </>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------- roles and teams */

function RolesAndTeams() {
  const { users, registry, setRole, openDrawer } = useAdmin();
  const active = users.filter((u) => u.status !== "Deactivated");
  const [effUser, setEffUser] = React.useState(active[0]?.name ?? "");
  const [handover, setHandover] = React.useState<string | null>(null);
  const eu = users.find((u) => u.name === effUser) ?? active[0];

  const roleRows = active.flatMap((u) =>
    u.apps.map((id) => ({ user: u, app: registry.find((a) => a.id === id)! })).filter((r) => r.app),
  );

  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="In-app roles"
          hint="MahekOne decides which apps you open; the app's role decides what you can do inside it. Each app declares its own role vocabulary."
        />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>App</Th>
                <Th>Role</Th>
                <Th>Reports to</Th>
                <Th>Team</Th>
              </tr>
            </thead>
            <tbody>
              {roleRows.map(({ user: u, app: a }, i) => {
                const role = u.roles[a.id] ?? a.roles[0];
                return (
                  <Tr key={`${u.id}-${a.id}`} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">{u.name}</Td>
                    <Td>{a.name}</Td>
                    <Td>
                      <Select value={role} onChange={(e) => setRole(u.id, a.id, e.target.value)}>
                        {a.roles.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </Select>
                    </Td>
                    <Td>{a.reportsTo && role !== a.managerRole ? (u.reportsTo ?? "—") : "—"}</Td>
                    <Td>
                      {role === a.managerRole
                        ? `${u.team ?? 0} ${u.team === 1 ? "report" : "reports"}`
                        : ""}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Effective permissions"
          hint="App access plus role, flattened — the definitive answer to “what can this person do?”"
        />
        <div className="border-b border-divider px-5 py-3.5">
          <Select value={effUser} onChange={(e) => setEffUser(e.target.value)} className="w-[280px]">
            {active.map((u) => (
              <option key={u.id}>{u.name}</option>
            ))}
          </Select>
        </div>
        {eu && eu.apps.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">
            {eu.name} has no app access, so they cannot do anything on the platform yet.
          </div>
        ) : null}
        {eu?.apps.map((id) => {
          const a = registry.find((x) => x.id === id)!;
          const role = eu.roles[id] ?? a.roles[0];
          return (
            <div key={id} className="border-t border-canvas px-4 py-3">
              <div className="text-sm font-medium text-ink">
                {a.name} · {role}
              </div>
              <div className="mt-0.5 text-[13px] leading-[19px] text-muted">{capabilities(role)}</div>
            </div>
          );
        })}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Role reference"
          hint="Read from each app's declared vocabulary — the console does not define capabilities."
        />
        {registry
          .filter((a) => a.status === "Live")
          .map((a) => (
            <div key={a.id} className="border-t border-canvas px-5 py-3.5">
              <div className="text-sm font-medium text-ink">{a.name}</div>
              {a.roles.map((r) => (
                <div key={r} className="mt-2">
                  <div className="flex items-baseline gap-2.5">
                    <span className="text-sm text-ink">{r}</span>
                    <span className="text-[13px] text-muted">
                      {users.filter((u) => u.roles[a.id] === r).length} holding
                    </span>
                  </div>
                  <div className="text-[13px] leading-[19px] text-muted">{capabilities(r)}</div>
                </div>
              ))}
            </div>
          ))}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Teams"
          hint="One manager each. Removing a manager requires nominating a replacement — a team without one has nobody its figures roll up to."
        />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Team</Th>
                <Th>App</Th>
                <Th>Manager</Th>
                <Th align="right">Members</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {TEAMS.map((t, i) => (
                <Tr
                  key={t.id}
                  onClick={() => openDrawer({ kind: "team", id: t.id })}
                  className={cx("cursor-pointer hover:bg-brand-soft", i % 2 ? "bg-canvas" : "")}
                >
                  <Td className="font-medium text-ink">{t.name}</Td>
                  <Td>{t.app}</Td>
                  <Td>{t.manager}</Td>
                  <Td align="right">{t.members.length}</Td>
                  <Td>
                    <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => setHandover(t.id)}>
                        Change manager
                      </Button>
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <ManagerHandover teamId={handover} onClose={() => setHandover(null)} />

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Reporting lines and workload"
          hint="Where an admin spots one person carrying twice the book of everyone else."
        />
        {TEAMS.map((t) => (
          <div key={t.id} className="border-t border-canvas px-5 py-3.5">
            <div className="text-sm font-medium text-ink">
              {t.manager} <span className="font-normal text-muted">· {t.app}</span>
            </div>
            <div className="mt-2 border-l-2 border-brand-softer pl-3.5">
              {t.members.map((m) => {
                const mu = users.find((u) => u.name === m);
                const book = mu ? ownedFor(mu.id).find((r) => r.key === "customers") : undefined;
                return (
                  <div key={m} className="flex items-baseline justify-between gap-4 py-1">
                    <span className="text-sm text-ink">{m}</span>
                    <span
                      className={cx(
                        "text-[13px] font-medium",
                        book && book.count > 130 ? "text-warn-ink" : "text-muted",
                      )}
                    >
                      {book ? `${book.count} customers` : "No book yet"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

/**
 * A manager cannot simply be removed. Their reports have to land on somebody,
 * and the replacement is nominated before anything changes.
 */
function ManagerHandover({ teamId, onClose }: { teamId: string | null; onClose: () => void }) {
  const { users, notify, record } = useAdmin();
  const team = TEAMS.find((t) => t.id === teamId);
  const candidates = users.filter(
    (u) => u.status === "Active" && Object.values(u.roles).includes("Manager") && u.name !== team?.manager,
  );
  const [to, setTo] = React.useState("");

  if (!team) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Change the manager of ${team.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!to}
            title={to ? undefined : "Nominate a replacement first"}
            onClick={() => {
              record("access", "Platform", `Team manager — ${team.name}`, team.manager, to);
              notify(`${team.name} now reports to ${to}. ${team.members.length} people moved with it.`);
              onClose();
            }}
          >
            Hand the team over
          </Button>
        </>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        {team.manager} manages {team.members.length} {team.members.length === 1 ? "person" : "people"} on {team.app}.
        They cannot simply be removed — their reports have to roll up to somebody.
      </div>
      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          New manager · required
        </span>
        <Select value={to} onChange={(e) => setTo(e.target.value)} className="w-full">
          <option value="">Nominate a replacement</option>
          {candidates.map((c) => (
            <option key={c.id}>{c.name}</option>
          ))}
        </Select>
      </label>
      <div className="mt-3 overflow-hidden rounded-[4px] border border-line">
        {team.members.map((m, i) => (
          <div key={m} className={cx("px-3.5 py-2 text-sm text-ink", i ? "border-t border-canvas" : "")}>
            {m} <span className="text-muted">would report to {to || "…"}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function capabilities(role: string): string {
  return role === "Manager"
    ? "Team figures · edit targets · close complaints · export · deactivate customers"
    : "Own book · log calls · collections · reminders · raise complaints";
}

/* ---------------------------------------------------- sessions and security */

function SessionsAndSecurity() {
  const { users, sessions, endSession, endAllSessions, patchUser, notify } = useAdmin();
  const locked = users.filter((u) => u.status === "Locked");

  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Live sessions"
          hint="Every active session on the platform, each one individually revocable."
          action={
            <Button size="sm" variant="ghost" className="text-danger" onClick={endAllSessions}>
              End every session
            </Button>
          }
        />
        {sessions.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">No active sessions.</div>
        ) : (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>User</Th>
                  <Th>App</Th>
                  <Th>Device</Th>
                  <Th>IP</Th>
                  <Th>Started</Th>
                  <Th>Last seen</Th>
                  <Th>State</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s, i) => (
                  <Tr key={s.id} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">{users.find((u) => u.id === s.user)?.name}</Td>
                    <Td>{s.app}</Td>
                    <Td>{s.device}</Td>
                    <Td>{s.ip}</Td>
                    <Td>{s.started}</Td>
                    <Td>{s.seen}</Td>
                    <Td>
                      <Badge tone={s.stale ? "neutral" : "success"}>{s.stale ? "Idle" : "Active"}</Badge>
                    </Td>
                    <Td>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => endSession(s.id)}>
                        End
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Locked accounts" />
        {locked.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">No accounts are locked.</div>
        ) : null}
        {locked.map((u, i) => (
          <div
            key={u.id}
            className={cx(
              "flex items-center gap-4 border-l-[3px] border-l-danger bg-danger-soft px-5 py-3.5",
              i ? "border-t border-t-canvas" : "",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{u.name}</span>
              <span className="block text-[13px] text-body">
                {u.lockReason} · {u.lastSeen}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                patchUser(u.id, { status: "Active", lockReason: undefined });
                notify(`${u.name} unlocked. No password was changed.`);
              }}
            >
              Unlock
            </Button>
          </div>
        ))}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Sign-in history" />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>When</Th>
                <Th>IP</Th>
                <Th>Device</Th>
                <Th>Outcome</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {SIGNINS.map((s, i) => (
                <Tr key={`${s.user}-${s.t}`} className={s.ok ? (i % 2 ? "bg-canvas" : "") : "bg-danger-soft"}>
                  <Td className="font-medium text-ink">{s.user}</Td>
                  <Td>{s.t}</Td>
                  <Td>{s.ip}</Td>
                  <Td>{s.device}</Td>
                  <Td>
                    <Badge tone={s.ok ? "success" : "danger"}>{s.ok ? "Signed in" : "Failed"}</Badge>
                  </Td>
                  <Td>{s.note}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Password reset log"
          hint="A reset sent but never used means someone is still locked out and has not said so."
        />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Triggered by</Th>
                <Th>When</Th>
                <Th>State</Th>
                <Th>Expiry</Th>
              </tr>
            </thead>
            <tbody>
              {RESETS.map((r, i) => (
                <Tr key={`${r.user}-${r.t}`} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{r.user}</Td>
                  <Td>{r.by}</Td>
                  <Td>{r.t}</Td>
                  <Td>
                    <Badge
                      tone={r.state === "Used" ? "success" : r.state === "Expired unused" ? "danger" : "warn"}
                    >
                      {r.state}
                    </Badge>
                  </Td>
                  <Td>{r.expires}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Flags"
          hint="Informational only. Nothing is blocked automatically — a false positive locking out a telecaller mid-shift costs more than the risk."
        />
        {SECURITY_FLAGS.map((line, i) => (
          <div key={line} className={cx("flex items-center gap-2.5 px-5 py-3", i ? "border-t border-canvas" : "")}>
            <span className="block h-1.5 w-1.5 flex-none rounded-full bg-warn" />
            <span className="text-sm text-ink">{line}</span>
          </div>
        ))}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Security policy" />
        {SECURITY_POLICY.map((p, i) => (
          <div
            key={p.label}
            className={cx("flex items-center justify-between gap-4 px-5 py-3", i ? "border-t border-canvas" : "")}
          >
            <span className="text-sm text-ink">{p.label}</span>
            <span className="flex items-center gap-2.5">
              <span className="text-sm font-medium text-ink">{p.value}</span>
              <Button size="sm" variant="ghost" onClick={() => notify(`${p.label} is a platform setting — edited here`)}>
                Edit
              </Button>
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- onboarding */

function Onboarding() {
  const { users, openDrawer, notify } = useAdmin();
  const invited = users.filter((u) => u.status === "Invited");
  const done = CHECKLIST.filter((c) => c.done).length;

  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Role templates"
          hint="Creating a user becomes choosing a template and typing a name."
          action={
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => openDrawer({ kind: "bulkInvite" })}>
                Bulk invite
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openDrawer({ kind: "createUser" })}>
                Create user from a template
              </Button>
              <Button size="sm" variant="primary" onClick={() => openDrawer({ kind: "template", id: null })}>
                New template
              </Button>
            </span>
          }
        />
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Template</Th>
                <Th>Department</Th>
                <Th>Apps</Th>
                <Th>Roles</Th>
                <Th>Used by</Th>
              </tr>
            </thead>
            <tbody>
              {ROLE_TEMPLATES.map((t, i) => (
                <Tr
                  key={t.id}
                  onClick={() => openDrawer({ kind: "template", id: t.id })}
                  className={cx("cursor-pointer hover:bg-brand-soft", i % 2 ? "bg-canvas" : "")}
                >
                  <Td className="font-medium text-ink">{t.name}</Td>
                  <Td>{t.dept}</Td>
                  <Td>{t.apps}</Td>
                  <Td>{t.roles}</Td>
                  <Td>
                    {t.used} {t.used === 1 ? "user" : "users"}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Invitations" />
        {invited.length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted">No invitations outstanding.</div>
        ) : (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Sent to</Th>
                  <Th>Sent</Th>
                  <Th>State</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {invited.map((u, i) => (
                  <Tr key={u.id} className={i % 2 ? "bg-canvas" : ""}>
                    <Td className="font-medium text-ink">{u.name}</Td>
                    <Td>{u.contact}</Td>
                    <Td>{u.invitedOn}</Td>
                    <Td>
                      <Badge tone="warn">Sent, not opened</Badge>
                    </Td>
                    <Td>
                      <span className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => notify(`Invitation resent to ${u.contact} — the previous link stops working`)}
                        >
                          Resend
                        </Button>
                        <Button size="sm" variant="ghost" className="text-danger" onClick={() => notify("Invitation revoked")}>
                          Revoke
                        </Button>
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Joiner checklist · Mahesh Parab" hint="So nobody sits half-onboarded." />
        <div className="border-b border-divider px-5 py-2.5 text-[13px] text-muted">
          {done} of {CHECKLIST.length} done
        </div>
        {CHECKLIST.map((c, i) => (
          <ChecklistRow key={c.label} label={c.label} done={c.done} first={i === 0} />
        ))}
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Leaver checklist · Suresh Kumar"
          hint="The mirror of the joiner list. A leaver who still owns work has not actually left the system."
        />
        <div className="border-b border-divider px-5 py-2.5 text-[13px] text-muted">
          {LEAVER_CHECKLIST.filter((c) => c.done).length} of {LEAVER_CHECKLIST.length} done
        </div>
        {LEAVER_CHECKLIST.map((c, i) => (
          <ChecklistRow key={c.label} label={c.label} done={c.done} first={i === 0} />
        ))}
      </Card>
    </div>
  );
}

function ChecklistRow({ label, done, first }: { label: string; done: boolean; first: boolean }) {
  return (
    <div className={cx("flex items-center gap-2.5 px-5 py-2.5", first ? "" : "border-t border-canvas")}>
      <span
        className={cx(
          "flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[4px] text-[11px] font-semibold text-ink",
          done ? "bg-brand-lime" : "bg-divider",
        )}
      >
        {done ? "✓" : ""}
      </span>
      <span className={cx("text-sm", done ? "text-muted line-through" : "text-ink")}>{label}</span>
    </div>
  );
}

export type { AdminUser };
