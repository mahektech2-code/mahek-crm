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
import type { AdminUser, UserStatus } from "./data";
import { endSessionsFor, sendPasswordResetFor } from "@/lib/actions/people";
import { pinnedCell, pinnedHead } from "./pinned";
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
  "Never signed in",
  "No app at all",
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
  // Sessions and never-signed-in are answered by the platform service and
  // rendered by the console; roles live in the roster, where the person is.
  if (tab === 1) return <AppAccess />;
  if (tab === 2) return <RolesAndReporting />;
  return <Roster onOpenUser={onOpenUser} />;
}

/* ------------------------------------------------------------------ roster */

function Roster({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const { users, registry, notify, openDrawer } = useAdmin();
  const [view, setView] = React.useState<View>("All active");
  const [selected, setSelected] = React.useState<string[]>([]);

  const inView = users.filter((u) => {
    if (view === "All active") return u.status !== "Deactivated";
    if (view === "Never signed in") return u.lastSeen === "Never";
    if (view === "No app at all") return u.apps.length === 0;
    if (view === "Single-app users") return u.apps.length === 1;
    if (view === "Managers") return u.platformRole === "manager" || u.platformRole === "admin";
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
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th className={cx(pinnedHead("left"), "w-11 border-r-0")} />
                <Th className={cx(pinnedHead("left"), "left-11")}>Name</Th>
                <Th>Code</Th>
                <Th>Team</Th>
                <Th>Reports to</Th>
                <Th>Status</Th>
                <Th>Apps</Th>
                <Th>Roles</Th>
                <Th align="right">Owns</Th>
                <Th>Last active</Th>
                <Th>Created</Th>
                {/* The roster is wider than the screen, so the actions stay
                    pinned rather than living past the right edge. */}
                <Th className={pinnedHead("right")} />
              </tr>
            </thead>
            <tbody>
              {inView.map((u, i) => {
                const on = selected.includes(u.id);
                const owns = u.customers;
                return (
                  <Tr
                    key={u.id}
                    onClick={() => onOpenUser(u.id)}
                    className={cx("cursor-pointer", on ? "bg-brand-soft" : i % 2 ? "bg-canvas" : "")}
                  >
                    <Td className={cx(pinnedCell("left", i, on), "w-11 border-r-0")}>
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
                    {/* Scrolled right to reach the actions, you must still be
                        able to see whose row this is. */}
                    <Td className={cx(pinnedCell("left", i, on), "left-11 font-medium text-ink")}>{u.name}</Td>
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
                      <span className="capitalize">{u.platformRole}</span>
                    </Td>
                    <Td align="right">{owns ? owns : "—"}</Td>
                    <Td>{u.lastActive}</Td>
                    <Td>{u.created}</Td>
                    <Td className={pinnedCell("right", i, on)}>
                      <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <RowMenu
                          items={[
                            { label: "Edit user", onSelect: () => openDrawer({ kind: "editUser", id: u.id }) },
                            {
                              // Both of these do the thing they say now. They
                              // used to write a line to an in-memory list and
                              // toast as though mail had been sent.
                              label: "Send a password reset link",
                              onSelect: () => {
                                void sendPasswordResetFor(u.id).then((r) =>
                                  notify(r.ok ? (r.message ?? "Sent.") : r.error),
                                );
                              },
                            },
                            {
                              label: "End every session",
                              onSelect: () => {
                                void endSessionsFor(u.id).then((r) =>
                                  notify(r.ok ? (r.message ?? "Ended.") : r.error),
                                );
                              },
                            },
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
  const { users, registry, toggleAppAccess } = useAdmin();
  const [pending, setPending] = React.useState<null | {
    userId: string; userName: string; appId: string; appName: string; grows: boolean; other: string;
  }>(null);

  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="App access"
          hint="This grid drives the launcher. Granting a second app changes that person's whole sign-in — they stop going straight into one app."
        />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
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

/* --------------------------------------------------- roles and reporting */

const ROLES: Array<{ id: AdminUser["platformRole"]; label: string; can: string }> = [
  {
    id: "telecaller",
    label: "Telecaller",
    can: "Their own book. Log calls, take orders, chase payments, raise complaints and reminders.",
  },
  {
    id: "manager",
    label: "Manager",
    can: "The team's book as well as their own. Targets, complaint closure, configuration, exports and deactivations.",
  },
  {
    id: "accounts",
    label: "Accounts",
    can: "Approve or decline orders, confirm or reject reported payments, and record receipts.",
  },
  {
    id: "admin",
    label: "Admin",
    can: "Everything a manager can, plus the platform sections of this console.",
  },
];

/**
 * One role per account, and who they report to.
 *
 * This replaced a matrix of role-per-app that wrote to nothing: MahekOne has a
 * single `users.role`, every capability check reads it, and the apps a person
 * opens are a separate question answered by the tab next door.
 */
function RolesAndReporting() {
  const { users, setPlatformRole } = useAdmin();
  const active = users.filter((u) => u.status !== "Deactivated");

  const reportsCount = (name: string) =>
    active.filter((u) => u.reportsTo === name).length;

  return (
    <div>
      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Roles"
          hint="What somebody can DO. Which apps they can open is the tab before this one — the two are deliberately separate, because access and job title drift apart the moment somebody covers for a colleague."
        />
        <div className="overflow-auto">
          <table className="[&_td]:whitespace-nowrap">
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Role</Th>
                <Th>Reports to</Th>
                <Th>Direct reports</Th>
                <Th>Customers</Th>
              </tr>
            </thead>
            <tbody>
              {active.map((u, i) => (
                <Tr key={u.id} className={i % 2 ? "bg-canvas" : ""}>
                  <Td className="font-medium text-ink">{u.name}</Td>
                  <Td>
                    <Select
                      value={u.platformRole}
                      onChange={(e) =>
                        setPlatformRole(u.id, e.target.value as AdminUser["platformRole"])
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </Td>
                  <Td>{u.reportsTo ?? "—"}</Td>
                  <Td>{reportsCount(u.name) || "—"}</Td>
                  <Td>{u.customers || "—"}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="What each role can do"
          hint="Enforced in the actions themselves, not by hiding buttons — a disabled control is a statement to the browser, and the browser is not where authority lives."
        />
        {ROLES.map((r, i) => (
          <div key={r.id} className={cx("px-5 py-3.5", i ? "border-t border-divider" : "")}>
            <div className="text-sm font-medium text-ink">{r.label}</div>
            <div className="mt-0.5 text-[13px] leading-[19px] text-muted">{r.can}</div>
            <div className="mt-1 text-[13px] text-muted">
              {active.filter((u) => u.platformRole === r.id).length} account
              {active.filter((u) => u.platformRole === r.id).length === 1 ? "" : "s"}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
