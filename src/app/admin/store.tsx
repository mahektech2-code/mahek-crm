"use client";

import * as React from "react";
import { useToast } from "@/components/ui/toast";
import { APPS } from "@/lib/apps";
import { setUserRole } from "@/lib/actions/people";
import type { Person } from "@/lib/services/admin-people-service";

/**
 * The console's registry, derived from the one registry that decides what
 * MahekOne actually has. It used to be a separate hand-written list of three,
 * so People could not grant the other four apps and the launcher and the
 * console disagreed about what existed.
 */
const FULL_REGISTRY: RegistryEntry[] = APPS.map((a, i) => {
  const sample = REGISTRY.find((r) => r.id === a.id);
  return {
    ...(sample ?? {}),
    id: a.id,
    name: a.name,
    short: sample?.short ?? a.initials,
    status: a.built ? "Live" : "Coming soon",
    route: a.href,
    roles: sample?.roles ?? [],
    order: sample?.order ?? 100 + i,
    desc: a.description,
  } as RegistryEntry;
});
import {
  ENTITIES,
  REGISTRY,
  type AdminUser,
  type EntityKind,
  type EntityRow,
  type RegistryEntry,
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
  /* Not an editor drawer — the Access screen's own dialog reads this, so the
     console header's primary action can open it the way every other section's
     primary action opens something. */
  | { kind: "enableAccess" }
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
  /** The signed-in account, as the actor on anything written from here. */
  me: { name: string };

  users: AdminUser[];
  registry: RegistryEntry[];
  entities: Record<EntityKind, EntityRow[]>;
  notes: Record<string, AdminNote[]>;

  notify: (message: string) => void;

  patchUser: (id: string, patch: Partial<AdminUser>) => void;
  /**
   * The account's ONE role. There is no role per app: `users.role` is what
   * every capability check reads, and the per-app matrix this replaced wrote
   * to nothing at all.
   */
  setPlatformRole: (id: string, role: AdminUser["platformRole"]) => void;
  archiveEntity: (kind: EntityKind, id: string) => void;
  addNote: (userId: string, text: string) => void;

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

/**
 * Real accounts, mapped into the shape this console was written around.
 *
 * Fields the database has no answer for are left empty rather than filled with
 * something plausible — that habit is what made the whole section a mockup.
 */
function toAdminUser(p: Person): AdminUser {
  const roleLabel = p.role.charAt(0).toUpperCase() + p.role.slice(1);
  const stamp = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  return {
    id: p.id,
    name: p.name,
    code: p.phone ?? "",
    dept: roleLabel,
    contact: p.email,
    mobile: p.phone ?? "",
    status: p.active ? "Active" : "Deactivated",
    apps: p.apps,
    platformRole: p.role,
    customers: p.customerCount,
    reportsTo: p.reportsToName ?? undefined,
    designation: roleLabel,
    lastSeen: stamp(p.lastLoginAt) || "Never",
    lastActive: stamp(p.lastLoginAt) || "Never",
    created: stamp(p.createdAt),
    createdBy: "",
    joined: stamp(p.createdAt),
  };
}

export function AdminStore({
  children,
  people,
  me,
}: {
  children: React.ReactNode;
  people: Person[];
  /** The signed-in account. What the audit trail records as the actor. */
  me: { name: string };
}) {
  const toast = useToast();
  // Seeded once from the database. Every write here updates this list and is
  // rolled back if the server refuses, and each action revalidates, so a
  // navigation brings the authoritative version. Deliberately no effect
  // syncing state to props: this codebase remounts rather than re-syncing.
  const [users, setUsers] = React.useState<AdminUser[]>(() => people.map(toAdminUser));
  // The real app list, not the console's three-entry sample. An access matrix
  // that cannot show four of the seven apps cannot grant them either.
  // The app list is code, not state: nothing in this console can add an app,
  // because adding one means writing it.
  const registry = FULL_REGISTRY;
  const [entities, setEntities] = React.useState(ENTITIES);
  const [notes, setNotes] = React.useState<Record<string, AdminNote[]>>({});
  const [drawer, setDrawer] = React.useState<Drawer | null>(null);

  const value = React.useMemo<Store>(() => {
    const notify = (message: string) => toast.push(message);

    const patchUser = (id: string, patch: Partial<AdminUser>) =>
      setUsers((all) => all.map((u) => (u.id === id ? { ...u, ...patch } : u)));

    return {
      me,
      users,
      registry,
      entities,
      notes,
      notify,
      patchUser,

      setPlatformRole: (id, role) => {
        const user = users.find((u) => u.id === id);
        if (!user) return;
        const before = user.platformRole;
        if (before === role) return;

        // Shown at once, then confirmed. A refused write puts the row back —
        // the console must never claim a change the server declined.
        patchUser(id, { platformRole: role });
        void setUserRole(id, role).then((result) => {
          if (!result.ok) {
            patchUser(id, { platformRole: before });
            notify(result.error);
            return;
          }
          notify(result.message ?? `${user.name} is now ${role}`);
        });
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

      drawer,
      openDrawer: setDrawer,
      closeDrawer: () => setDrawer(null),
    };
  }, [me, users, registry, entities, notes, drawer, toast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
