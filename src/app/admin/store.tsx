"use client";

import * as React from "react";
import { useToast } from "@/components/ui/toast";
import {
  AUDIT,
  DEFAULT_ACCESS_RULES,
  ENTITIES,
  EXPIRING,
  PERSONAS,
  REGISTRY,
  REQUESTS,
  SESSIONS,
  UNUSED_ACCESS,
  USERS,
  type AdminUser,
  type AccessRequest,
  type AuditKind,
  type AuditRow,
  type EntityKind,
  type EntityRow,
  type Persona,
  type RegistryEntry,
  type Session,
} from "./data";

/* ---------------------------------------------------------------------------
 * One store for the whole console.
 *
 * The design's screens all read and write the same handful of collections — a
 * revoked grant has to disappear from the roster, the access matrix and the
 * user's own record at once. Holding them in one place is what stops those
 * three screens from disagreeing about the same person.
 *
 * Everything is in memory today. When these become server actions, only this
 * file changes.
 * ------------------------------------------------------------------------- */

export type Drawer =
  | { kind: EntityKind; id: string | null }
  | { kind: "createUser" }
  | { kind: "editUser"; id: string }
  | { kind: "deactivate"; id: string }
  | { kind: "delegate"; id: string }
  | { kind: "leave"; id: string }
  | { kind: "decline"; id: string }
  | { kind: "registerApp"; id?: string }
  | { kind: "template"; id: string | null }
  | { kind: "bulkInvite" }
  | { kind: "announcement"; id: string | null }
  | { kind: "team"; id: string };

export type AdminNote = { text: string; by: string; t: string };

type Store = {
  me: Persona;
  personas: Persona[];
  setPersona: (key: string) => void;

  users: AdminUser[];
  sessions: Session[];
  requests: AccessRequest[];
  registry: RegistryEntry[];
  audit: AuditRow[];
  entities: Record<EntityKind, EntityRow[]>;
  accessRules: Array<{ line: string; on: boolean }>;
  expiring: typeof EXPIRING;
  unused: typeof UNUSED_ACCESS;
  notes: Record<string, AdminNote[]>;

  notify: (message: string) => void;
  record: (kind: AuditKind, app: string, setting: string, from: string, to: string, subject?: string | null) => void;

  patchUser: (id: string, patch: Partial<AdminUser>) => void;
  toggleAppAccess: (id: string, appId: string) => void;
  setRole: (id: string, appId: string, role: string) => void;
  revokeGrant: (id: string, appId: string) => void;
  endSession: (sessionId: string) => void;
  endAllSessions: () => void;
  resolveRequest: (id: string, approved: boolean) => void;
  setAppStatus: (appId: string, status: RegistryEntry["status"]) => void;
  toggleAccessRule: (index: number) => void;
  archiveEntity: (kind: EntityKind, id: string) => void;
  addNote: (userId: string, text: string) => void;
  endExpiring: (index: number) => void;
  revokeUnused: (index: number) => void;

  drawer: Drawer | null;
  openDrawer: (d: Drawer) => void;
  closeDrawer: () => void;
};

const Ctx = React.createContext<Store | null>(null);

export function useAdmin(): Store {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useAdmin must be used inside <AdminStore>");
  return ctx;
}

export function AdminStore({ children }: { children: React.ReactNode }) {
  const toast = useToast();

  const [personaKey, setPersonaKey] = React.useState(PERSONAS[0].key);
  const [users, setUsers] = React.useState<AdminUser[]>(USERS);
  const [sessions, setSessions] = React.useState<Session[]>(SESSIONS);
  const [requests, setRequests] = React.useState<AccessRequest[]>(REQUESTS);
  const [registry, setRegistry] = React.useState<RegistryEntry[]>(REGISTRY);
  const [audit, setAudit] = React.useState<AuditRow[]>(AUDIT);
  const [entities, setEntities] = React.useState(ENTITIES);
  const [accessRules, setAccessRules] = React.useState(DEFAULT_ACCESS_RULES);
  const [expiring, setExpiring] = React.useState(EXPIRING);
  const [unused, setUnused] = React.useState(UNUSED_ACCESS);
  const [notes, setNotes] = React.useState<Record<string, AdminNote[]>>({});
  const [drawer, setDrawer] = React.useState<Drawer | null>(null);

  const me = PERSONAS.find((p) => p.key === personaKey) ?? PERSONAS[0];

  const value = React.useMemo<Store>(() => {
    const notify = (message: string) => toast.push(message);

    const record = (
      kind: AuditKind, app: string, setting: string, from: string, to: string, subject?: string | null,
    ) => setAudit((rows) => [{ kind, app, setting, from, to, actor: me.name, subject: subject ?? null, t: "Just now" }, ...rows]);

    const patchUser = (id: string, patch: Partial<AdminUser>) =>
      setUsers((all) => all.map((u) => (u.id === id ? { ...u, ...patch } : u)));

    return {
      me,
      personas: PERSONAS,
      setPersona: setPersonaKey,
      users,
      sessions,
      requests,
      registry,
      audit,
      entities,
      accessRules,
      expiring,
      unused,
      notes,
      notify,
      record,
      patchUser,

      /**
       * Granting a second app changes that person's whole sign-in: they stop
       * going straight into one app and land on the launcher instead. The
       * console says so rather than leaving them to discover it tomorrow.
       */
      toggleAppAccess: (id, appId) => {
        const user = users.find((u) => u.id === id);
        if (!user) return;
        const had = user.apps.includes(appId);
        const apps = had ? user.apps.filter((a) => a !== appId) : [...user.apps, appId];
        const app = registry.find((a) => a.id === appId);
        const grants = had
          ? user.grants.filter((g) => g.app !== appId)
          : [...user.grants, { app: appId, by: me.name, on: "Today", reason: "Granted from the access matrix" }];
        patchUser(id, { apps, grants });
        record("access", "Platform", had ? `App access revoked — ${app?.name}` : `App access granted — ${app?.name}`, had ? user.name : "—", had ? "—" : user.name);

        if (user.apps.length === 1 && apps.length === 2) {
          notify(`${user.name} now lands on the launcher instead of going straight into one app`);
        } else if (user.apps.length === 2 && apps.length === 1) {
          notify(`${user.name} will now be taken straight into ${registry.find((a) => a.id === apps[0])?.name}`);
        } else {
          notify(had ? `Access revoked · ${app?.short}` : `Access granted · ${app?.short}`);
        }
      },

      setRole: (id, appId, role) => {
        const user = users.find((u) => u.id === id);
        if (!user) return;
        const app = registry.find((a) => a.id === appId);
        patchUser(id, { roles: { ...user.roles, [appId]: role } });
        record("access", "Platform", `Role changed — ${app?.short}`, user.roles[appId] ?? "—", role);
        notify(`${user.name} is now ${role} in ${app?.short}`);
      },

      revokeGrant: (id, appId) => {
        const user = users.find((u) => u.id === id);
        if (!user) return;
        const app = registry.find((a) => a.id === appId);
        patchUser(id, {
          apps: user.apps.filter((a) => a !== appId),
          grants: user.grants.filter((g) => g.app !== appId),
        });
        record("access", "Platform", `App access revoked — ${app?.name}`, user.name, "—");
        notify(`${app?.name} access revoked from ${user.name}`);
      },

      endSession: (sessionId) => {
        const s = sessions.find((x) => x.id === sessionId);
        setSessions((all) => all.filter((x) => x.id !== sessionId));
        const who = users.find((u) => u.id === s?.user);
        notify(who ? `Session ended for ${who.name}` : "Session ended");
      },

      endAllSessions: () => {
        setSessions([]);
        notify("Every session on the platform has been ended");
      },

      resolveRequest: (id, approved) => {
        const r = requests.find((x) => x.id === id);
        if (!r) return;
        setRequests((all) => all.filter((x) => x.id !== id));
        record("access", "Platform", `Access request ${approved ? "approved" : "declined"} — ${r.app}`, "Pending", approved ? "Granted" : "Declined");
        notify(approved ? `${r.app} access granted to ${r.user}` : `Request declined — ${r.user} is told why`);
      },

      /**
       * Maintenance mode shows a banner inside the app and marks its launcher
       * card, so nobody opens it and wonders why the figures look wrong.
       */
      setAppStatus: (appId, status) => {
        const app = registry.find((a) => a.id === appId);
        if (!app) return;
        setRegistry((all) => all.map((a) => (a.id === appId ? { ...a, status } : a)));
        record("admin", "Platform", `App status — ${app.name}`, app.status, status);
        notify(`${app.name} set to ${status} — a banner shows inside the app and on its launcher card`);
      },

      toggleAccessRule: (index) => {
        setAccessRules((all) => all.map((r, i) => (i === index ? { ...r, on: !r.on } : r)));
        notify("Default access rule updated");
      },

      /** Retired records are deactivated, never deleted — old references must keep resolving. */
      archiveEntity: (kind, id) => {
        const row = entities[kind].find((r) => r.id === id);
        if (!row) return;
        setEntities((all) => ({
          ...all,
          [kind]: all[kind].map((r) => (r.id === id ? { ...r, active: !r.active } : r)),
        }));
        notify(`${row.name}${row.active ? " archived — history keeps resolving to it" : " restored"}`);
      },

      addNote: (userId, text) => {
        setNotes((all) => ({ ...all, [userId]: [{ text, by: me.name, t: "Just now" }, ...(all[userId] ?? [])] }));
        notify("Note added");
      },

      endExpiring: (index) => {
        const row = expiring[index];
        setExpiring((all) => all.filter((_, i) => i !== index));
        notify(`Access ended for ${row.who}`);
      },

      revokeUnused: (index) => {
        const row = unused[index];
        setUnused((all) => all.filter((_, i) => i !== index));
        notify(`${row.app} access revoked from ${row.who}`);
      },

      drawer,
      openDrawer: setDrawer,
      closeDrawer: () => setDrawer(null),
    };
  }, [me, users, sessions, requests, registry, audit, entities, accessRules, expiring, unused, notes, drawer, toast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
