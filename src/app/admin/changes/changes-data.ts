import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { describeAudit, type Piece } from "@/lib/audit-labels";
import { definition } from "@/lib/config/registry";
import { settingAddress } from "@/lib/config/settings-schemas";
import { settingsPage } from "@/lib/config/settings-pages";
import { valueLine } from "@/lib/services/admin-console-service";

/**
 * Every change to how MahekOne is set up, from the audit rows the writers
 * already keep: a setting, a credential, the expense policy, the catalogue, the
 * WhatsApp switch. Nothing here is stored; a kind is a family of audit actions.
 */

export const KINDS = [
  {
    slug: "settings",
    label: "Settings",
    where: "a.action = 'config.update' and a.entity_type = 'app_setting'",
  },
  {
    slug: "expense",
    label: "Expense policy",
    where: "a.action like 'expense\\_policy.%'",
  },
  {
    slug: "catalogue",
    label: "Catalogue",
    where: "a.action like 'catalogue.%'",
  },
  { slug: "keys", label: "Keys", where: "a.action like 'secret.%'" },
  {
    slug: "switches",
    label: "Switches",
    where: "a.action in ('whatsapp.service_on', 'whatsapp.service_off')",
  },
] as const;
export type Kind = (typeof KINDS)[number]["slug"];

export type ChangeRow = {
  id: string;
  at: Date;
  kind: Kind;
  action: string;
  key: string | null;
  title: string;
  /** The app or area pill beside the title. */
  area: string;
  /** A mono line under the title. */
  sub: string | null;
  from: string | null;
  to: string | null;
  actor: string | null;
  /** A setting's newest change, whose earlier value can be put back. */
  restore: { key: string; value: unknown; label: string } | null;
};

const any = sql.raw(KINDS.map((k) => `(${k.where})`).join(" or "));
const kindCase = sql.raw(
  `case ${KINDS.map((k) => `when ${k.where} then '${k.slug}'`).join(" ")} end`,
);

type Raw = {
  id: string;
  at: Date;
  kind: Kind;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor: string | null;
  actor_id: string | null;
  before: unknown;
  after: unknown;
  latest: boolean;
};

export async function changeCounts(
  days: number,
  q: string | null,
): Promise<Record<Kind, number>> {
  const res = (await db.execute(sql`
    select ${kindCase} as kind, count(*)::int as n
      from audit_log a left join users u on u.id = a.actor_id
     where (${any}) and a.at > now() - (${days}::int * interval '1 day')
       ${q ? sql`and (lower(coalesce(a.entity_id, '')) like ${q} or lower(coalesce(u.name, '')) like ${q})` : sql``}
     group by 1`)) as unknown as { kind: Kind; n: number }[];
  const out = Object.fromEntries(KINDS.map((k) => [k.slug, 0])) as Record<
    Kind,
    number
  >;
  for (const r of res) if (r.kind) out[r.kind] = r.n;
  return out;
}

export async function changeRows(
  days: number,
  q: string | null,
  kind: Kind | null,
  limit = 300,
): Promise<ChangeRow[]> {
  const pick = kind ? sql.raw(KINDS.find((k) => k.slug === kind)!.where) : any;
  const res = (await db.execute(sql`
    select a.id, a.at, ${kindCase} as kind, a.action, a.entity_type, a.entity_id,
           u.name as actor, a.actor_id, a.before_state as before, a.after_state as after,
           (a.action = 'config.update'
             and a.at = max(a.at) filter (where a.action = 'config.update') over (partition by a.entity_id)) as latest
      from audit_log a left join users u on u.id = a.actor_id
     where (${pick}) and a.at > now() - (${days}::int * interval '1 day')
       ${q ? sql`and (lower(coalesce(a.entity_id, '')) like ${q} or lower(coalesce(u.name, '')) like ${q})` : sql``}
     order by a.at desc, a.id desc
     limit ${limit}`)) as unknown as Raw[];
  return res.map(toRow);
}

/** One setting's whole history, newest first, for the side panel. */
export async function settingHistory(key: string) {
  const res = (await db.execute(sql`
    select a.at, u.name as actor, a.before_state as before, a.after_state as after
      from audit_log a left join users u on u.id = a.actor_id
     where a.action = 'config.update' and a.entity_type = 'app_setting' and a.entity_id = ${key}
     order by a.at desc
     limit 50`)) as unknown as {
    at: Date;
    actor: string | null;
    before: { value?: unknown } | null;
    after: { value?: unknown } | null;
  }[];
  return res.map((r) => ({
    at: new Date(r.at),
    actor: r.actor,
    from: r.before && "value" in r.before ? valueLine(r.before.value) : null,
    to: valueLine(r.after?.value),
  }));
}

export function areaOf(key: string): string {
  const where = settingAddress(key);
  const page = where ? settingsPage(where.page) : undefined;
  return page ? shortArea(page.label) : "Settings";
}

const shortArea = (label: string) =>
  label === "Telecaller CRM" ? "CRM" : label.split(" ")[0];

const text = (pieces: Piece[]) =>
  pieces
    .map((p) => (typeof p === "string" ? p : "strong" in p ? p.strong : p.name))
    .join("")
    .trim();

function toRow(r: Raw): ChangeRow {
  const base = {
    id: r.id,
    at: new Date(r.at),
    kind: r.kind,
    action: r.action,
    actor: r.actor,
    restore: null,
    sub: null,
    key: null,
  };
  if (r.kind === "settings") {
    const key = r.entity_id ?? "";
    const def = definition(key);
    const before = (r.before as { value?: unknown } | null)?.value;
    const after = (r.after as { value?: unknown } | null)?.value;
    return {
      ...base,
      key,
      title: def?.label ?? key,
      area: areaOf(key),
      sub: key,
      from: r.before ? valueLine(before) : "—",
      to: valueLine(after),
      restore:
        r.latest && def && before !== undefined
          ? { key, value: before, label: valueLine(before) }
          : null,
    };
  }
  if (r.kind === "keys") {
    const after = (r.after ?? {}) as { last4?: string };
    return {
      ...base,
      title: r.action === "secret.clear" ? "Key cleared" : "Key saved",
      area: "Keys",
      sub: `${r.entity_id ?? ""}${after.last4 ? ` · ····${after.last4}` : ""}`,
      from: null,
      to: null,
    };
  }
  if (r.kind === "switches") {
    const on = r.action === "whatsapp.service_on";
    return {
      ...base,
      title: "WhatsApp through Wati",
      area: "HQ",
      from: on ? "Off" : "On",
      to: on ? "On" : "Off",
    };
  }
  const d = describeAudit(
    {
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      before: r.before,
      after: r.after,
      subjectId: null,
    },
    { users: {}, customers: {}, employees: {}, settings: {} },
  );
  const said = text(d.says);
  const first = d.changes[0];
  return {
    ...base,
    title: said ? said.charAt(0).toUpperCase() + said.slice(1) : r.action,
    area: r.kind === "expense" ? "Expense" : "Catalogue",
    from: first ? first.from : null,
    to: first ? first.to : null,
  };
}
