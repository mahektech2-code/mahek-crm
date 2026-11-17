import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { definition } from "@/lib/config/registry";
import { getConfig } from "@/lib/config/store";
import { AUDIT_GROUPS, translate } from "@/lib/audit-labels";

/* ---------------------------------------------------------------------------
 * The reads behind the Admin Console screens added in the v4 redraw: Change
 * history, Data health, App releases and Storage & files.
 *
 * Every one answers from what MahekOne already records. Nothing here is a new
 * table: a screen that needed one was left out of the redraw rather than
 * filled with a figure nobody stores.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const rows = async <T extends Row>(q: ReturnType<typeof sql>): Promise<T[]> =>
  (await db.execute(q)) as unknown as T[];

/* ------------------------------------------------------------ change history */

export type ConfigChange = {
  id: string;
  at: Date;
  key: string;
  label: string;
  actor: string | null;
  before: unknown;
  after: unknown;
  /** Whether the setting still exists and so can be put back. */
  restorable: boolean;
  /** Whether the value now is still what this change set — only then is "restore" meaningful. */
  isLatest: boolean;
};

/**
 * Every configuration change, newest first. A setting write already audits
 * itself with the value before and after (`config/store.ts`), one row per
 * setting, so this is a read of that and nothing more.
 */
export async function configChanges(opts: { q?: string; limit?: number } = {}): Promise<ConfigChange[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  const needle = opts.q?.trim() ? `%${opts.q.trim().toLowerCase()}%` : null;
  const list = await rows<{
    id: string;
    at: Date;
    key: string;
    actor: string | null;
    before: { value?: unknown } | null;
    after: { value?: unknown } | null;
    latest: boolean;
  }>(sql`
    select a.id, a.at, a.entity_id as key, u.name as actor,
           a.before_state as before, a.after_state as after,
           a.at = max(a.at) over (partition by a.entity_id) as latest
      from audit_log a
      left join users u on u.id = a.actor_id
     where a.action = 'config.update' and a.entity_type = 'app_setting'
       ${needle ? sql`and (lower(a.entity_id) like ${needle} or lower(coalesce(u.name, '')) like ${needle})` : sql``}
     order by a.at desc, a.id desc
     limit ${limit}`);
  return list.map((r) => {
    const def = definition(r.key);
    return {
      id: r.id,
      at: new Date(r.at),
      key: r.key,
      label: def?.label ?? r.key,
      actor: r.actor,
      before: r.before?.value,
      after: r.after?.value,
      restorable: !!def,
      isLatest: !!r.latest,
    };
  });
}

/** A stored value as one short line for a diff. */
export function valueLine(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  return "Changed list";
}

/* --------------------------------------------------------------- data health */

export type HealthCheck = {
  id: string;
  label: string;
  n: number;
  /** danger: wrong figures follow from it; warn: worth tidying; a zero is always ok. */
  tone: "danger" | "warn";
  href?: string;
  hint?: string;
};

/** Checks over the book. Each is one count, and each names where it is fixed. */
export async function dataHealthChecks(links: {
  sheets: string;
  catalogue: string;
  customers: string;
}): Promise<HealthCheck[]> {
  const [r] = await rows<{
    conflicts: number;
    third_party: number;
    no_state: number;
    unplaced: number;
    orphan_files: number;
    held_skus: number;
  }>(sql`
    select
      (select count(*)::int from sync_conflicts where resolved_at is null) as conflicts,
      (select count(*)::int from customers c
        where c.third_party and c.status <> 'deactivated'
          and not exists (select 1 from customer_distributors d where d.customer_id = c.id)) as third_party,
      (select count(*)::int from customers c
        where c.status <> 'deactivated' and c.resolved_state_id is null
          and coalesce(trim(c.region), '') = '') as no_state,
      (select count(*)::int from customers c
        where c.status <> 'deactivated' and c.resolved_state_id is null) as unplaced,
      (select count(*)::int from attachments a
        where a.parent_id is null and a.status <> 'removed'
          and a.created_at < now() - interval '1 day') as orphan_files,
      (select count(*)::int from products p where p.status = 'needs_canonical_id') as held_skus`);
  return [
    { id: "conflicts", label: "Sheet conflicts unresolved", n: r.conflicts, tone: "danger", href: links.sheets },
    {
      id: "third-party",
      label: "Third-party shops with nobody billing them",
      n: r.third_party,
      tone: "danger",
      href: links.customers,
      hint: "A shop we deliver to with no distributor recorded",
    },
    { id: "duplicates", label: "SKUs waiting for a canonical ID", n: r.held_skus, tone: "warn", href: links.catalogue },
    {
      id: "no-state",
      label: "Shops naming no state",
      n: r.no_state,
      tone: "warn",
      hint: "No territory can reach them",
    },
    { id: "unplaced", label: "Shops not placed on the tree", n: r.unplaced, tone: "warn" },
    {
      id: "orphans",
      label: "Files attached to nothing",
      n: r.orphan_files,
      tone: "warn",
      hint: "The nightly sweep removes these",
    },
  ];
}

/* ---------------------------------------------------------------- releases */

export type BuildCount = { version: string; phones: number; lastSeen: Date | null };

/** Which build every active phone runs, newest build first. */
export async function buildDistribution(): Promise<{ field: BuildCount[]; factory: BuildCount[] }> {
  const [field, factory] = await Promise.all([
    rows<{ version: string | null; phones: number; last_seen: Date | null }>(sql`
      select app_version as version, count(*)::int as phones, max(coalesce(last_request_at, last_seen_at)) as last_seen
        from mbos_devices
       where active
       group by app_version`),
    rows<{ version: string | null; phones: number; last_seen: Date | null }>(sql`
      select app_version as version, count(*)::int as phones, max(last_seen_at) as last_seen
        from factory_devices
       where last_seen_at > now() - interval '30 days'
       group by app_version`),
  ]);
  const shape = (list: typeof field) =>
    list
      .map((r) => ({ version: r.version ?? "Not reported", phones: r.phones, lastSeen: r.last_seen ? new Date(r.last_seen) : null }))
      .sort((a, b) => compareVersions(b.version, a.version));
  return { field: shape(field), factory: shape(factory) };
}

/** "1.16.2" against "1.9.0", numerically; anything unparseable sorts last. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v.split(/[\s(+-]/)[0]) ? v.split(/[\s(+-]/)[0].split(".").map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return a.localeCompare(b);
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/* ----------------------------------------------------------------- storage */

export type StorageKind = { kind: string; files: number; bytes: number };

export async function storageSummary(): Promise<{
  kinds: StorageKind[];
  files: number;
  bytes: number;
  removed: number;
  unattached: number;
  largest: { filename: string; bytes: number } | null;
  retention: { label: string; value: string; key: string }[];
}> {
  const [kinds, [totals], [largest], config] = await Promise.all([
    rows<{ kind: string | null; files: number; bytes: number }>(sql`
      select parent_type::text as kind, count(*)::int as files, coalesce(sum(size_bytes), 0)::float8 as bytes
        from attachments
       where status <> 'removed'
       group by parent_type
       order by 3 desc`),
    rows<{ files: number; bytes: number; removed: number; unattached: number }>(sql`
      select count(*) filter (where status <> 'removed')::int as files,
             coalesce(sum(size_bytes) filter (where status <> 'removed'), 0)::float8 as bytes,
             count(*) filter (where status = 'removed')::int as removed,
             count(*) filter (where status <> 'removed' and parent_id is null)::int as unattached
        from attachments`),
    rows<{ filename: string; bytes: number }>(sql`
      select filename, size_bytes::float8 as bytes from attachments
       where status <> 'removed' order by size_bytes desc limit 1`),
    getConfig(),
  ]);
  const c = config as unknown as Record<string, unknown>;
  const keep = (key: string, unit: string) => {
    const def = definition(key);
    const v = c[key];
    return def ? { key, label: def.label, value: v === undefined || v === null ? "—" : `${v} ${unit}` } : null;
  };
  const retention = [
    keep("mbos.attendance.selfieRetentionHours", "hours"),
    keep("bankStatements.pdfRetentionDays", "days"),
    keep("attachments.orphanCleanupHours", "hours"),
    keep("attachments.maxSizeMb", "MB a file"),
  ].filter((x): x is { key: string; label: string; value: string } => x !== null);
  return {
    kinds: kinds.map((k) => ({ kind: k.kind ?? "Not attached yet", files: k.files, bytes: k.bytes })),
    files: totals.files,
    bytes: totals.bytes,
    removed: totals.removed,
    unattached: totals.unattached,
    largest: largest ?? null,
    retention,
  };
}

/** Bytes as people read them. */
export function sizeLine(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/* ------------------------------------------------------------ recent activity */

export type AdminActivity = { id: string; at: Date; actor: string | null; says: string; entity: string | null };

/** The last few things administrators did — access, settings and keys — for Home. */
export async function recentAdminActivity(limit = 6): Promise<AdminActivity[]> {
  const prefixes = AUDIT_GROUPS.filter((g) => g.slug === "access" || g.slug === "settings").flatMap((g) =>
    g.prefixes.map((p) => `${p}%`),
  );
  const list = await rows<{ id: string; at: Date; actor: string | null; action: string; entity: string | null }>(sql`
    select a.id, a.at, u.name as actor, a.action, a.entity_id as entity
      from audit_log a
      left join users u on u.id = a.actor_id
     where a.action like any(${sql.raw(`array[${prefixes.map((p) => `'${p.replace(/'/g, "''")}'`).join(",")}]`)})
       and a.action <> 'access.denied'
     order by a.at desc
     limit ${limit}`);
  return list.map((r) => {
    const def = r.action === "config.update" && r.entity ? definition(r.entity) : undefined;
    return {
      id: r.id,
      at: new Date(r.at),
      actor: r.actor,
      says: translate(r.action).says,
      entity: def?.label ?? r.entity,
    };
  });
}
