"use server";

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { hireContext, scopeWhere } from "../access";

export type HireSearchHit = { group: "Candidates" | "Roles"; name: string; meta: string; href: string };

/** The header search: candidates in this person's scope, by name, phone or code; and roles. */
export async function hireSearch(term: string): Promise<HireSearchHit[]> {
  const ctx = await hireContext();
  if (!ctx) return [];
  const q = term.trim().toLowerCase();
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, "");
  const like = `%${q}%`;
  const cands = (await db.execute(sql`
    select a.id, c.full_name, c.code, b.title, a.location, a.stage_key, b.definition
    from hire_applications a join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and (lower(c.full_name) like ${like} or lower(c.code) = ${q}
      ${digits.length >= 4 ? sql`or c.primary_phone like ${"%" + digits + "%"}` : sql``}
      or exists (select 1 from jsonb_array_elements_text(c.name_variants) v where lower(v) like ${like}))
    order by a.applied_at desc limit 6`)) as unknown as Record<string, unknown>[];
  const hits: HireSearchHit[] = cands.map((r) => {
    const def = r.definition as { stages: { key: string; name: string }[] };
    const st = def.stages.find((s) => s.key === r.stage_key);
    return { group: "Candidates", name: String(r.full_name), meta: [r.code, r.title, r.location, st?.name].filter(Boolean).join(" · "), href: `/hire/c/${r.id}` };
  });
  if (ctx.role !== "interviewer" && ctx.role !== "onboarding") {
    const roles = (await db.execute(sql`
      select distinct on (key) id, key, title, version, status, family from hire_blueprints
      where lower(title) like ${like} or lower(family) like ${like} order by key, version desc limit 4`)) as unknown as Record<string, unknown>[];
    for (const r of roles) hits.push({ group: "Roles", name: String(r.title), meta: `${r.family} · v${r.version} · ${r.status}`, href: `/hire/blueprints/${r.id}` });
  }
  return hits;
}
