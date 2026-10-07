import "server-only";
import { sql } from "drizzle-orm";
import { cosineSimilarity } from "ai";
import { db } from "@/db";
import { hireAiOutputs } from "@/db/schema";
import { REJECTION_LABEL, type BlueprintDefinition } from "../blueprint-types";
import { scopeWhere, type HireContext } from "../access";
import { contentHash, embedTexts, EMBEDDING_MODEL } from "../ai/embeddings";
import { hid } from "./core";

/* ---------------------------------------------------------------------------
 * THE TALENT POOL (design brief §7.11): every past candidate, searchable in
 * plain words, and the strong ones who were not hired brought back when a
 * matching role is open.
 *
 * Two rules apply before anything is ranked: a candidate marked do-not-contact
 * is never offered, and a closed record past its blueprint's retention period
 * is not in the pool at all — retention is a promise about how long we hold
 * somebody's data, and search is not an exception to it.
 * ------------------------------------------------------------------------- */

type Raw = Record<string, unknown>;

export type PoolPerson = {
  applicationId: string;
  candidateId: string;
  code: string;
  name: string;
  location: string | null;
  bpKey: string;
  bpTitle: string;
  version: number;
  family: string;
  status: string;
  stageName: string;
  appliedAt: string;
  closedAt: string | null;
  overall: number | null;
  poolStatus: string;
  rejection: string | null;
  decisionReason: string | null;
  /** What the candidate said, confirmed answers only — the searchable evidence. */
  said: { text: string; source: string }[];
  profile: string;
  hasOpen: boolean;
};

/** One row per candidate — their latest application — inside scope, retention and do-not-contact. */
async function people(ctx: HireContext, now: number): Promise<PoolPerson[]> {
  const rows = (await db.execute(sql`
    select distinct on (c.id)
      a.id, c.id as candidate_id, c.code, c.full_name, a.location, b.key as bp_key, b.title as bp_title, b.version, b.family,
      b.definition, b.retention_months, a.status, a.stage_key, a.applied_at, a.closed_at, a.updated_at, c.talent_pool_status,
      a.rejection_reason_code, a.rejection_stage_key,
      (select d.reasoning from hire_decisions d where d.application_id = a.id and d.superseded_by_id is null order by d.decided_at desc limit 1) as decision_reason,
      (select avg(x.final_score) from hire_stage_executions x where x.application_id = a.id and x.superseded_by_id is null and x.final_score is not null) as overall,
      (select json_agg(json_build_object('t', w.response_text, 'k', w.question_key, 's', x.stage_key) order by w.created_at)
         from hire_answers w join hire_stage_executions x on x.id = w.execution_id
        where x.application_id = a.id and x.superseded_by_id is null and w.superseded_by_id is null
          and w.confirmed_at is not null and w.response_text is not null and w.scored_by in ('ai','human','manual')) as said,
      (select p.data from hire_profiles p where p.application_id = a.id) as profile,
      exists (select 1 from hire_applications o where o.candidate_id = c.id and o.status in ('in_progress','on_hold')) as has_open
    from hire_applications a
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and c.do_not_contact = false and c.talent_pool_status not in ('archived','withdrawn')
    order by c.id, a.applied_at desc
  `)) as unknown as Raw[];
  return rows
    .filter((r) => {
      if (!r.closed_at || r.status === "in_progress" || r.status === "on_hold") return true;
      const limit = new Date(r.closed_at as string).getTime() + Number(r.retention_months ?? 24) * 30.44 * 86_400_000;
      return limit > now;
    })
    .map((r) => {
      const def = r.definition as BlueprintDefinition;
      const stageName = (k: unknown) => def.stages.find((s) => s.key === k)?.name ?? String(k ?? "");
      const prof = r.profile as { fields?: Record<string, { value: string }>; employers?: { name: string; title: string }[]; skills?: string[] } | null;
      const profile = prof
        ? [
            ...Object.entries(prof.fields ?? {}).map(([k, v]) => `${k}: ${v.value}`),
            ...(prof.employers ?? []).map((e) => `${e.title} at ${e.name}`),
            (prof.skills ?? []).join(", "),
          ]
            .filter(Boolean)
            .join(". ")
        : "";
      return {
        applicationId: String(r.id),
        candidateId: String(r.candidate_id),
        code: String(r.code),
        name: String(r.full_name),
        location: (r.location as string) ?? null,
        bpKey: String(r.bp_key),
        bpTitle: String(r.bp_title),
        version: Number(r.version),
        family: String(r.family),
        status: String(r.status),
        stageName: r.status === "hired" ? "Hired" : stageName(r.stage_key),
        appliedAt: new Date(r.applied_at as string).toISOString(),
        closedAt: r.closed_at ? new Date(r.closed_at as string).toISOString() : null,
        overall: r.overall == null ? null : Math.round(Number(r.overall)),
        poolStatus: String(r.talent_pool_status),
        rejection: r.rejection_reason_code ? `${REJECTION_LABEL[String(r.rejection_reason_code)] ?? r.rejection_reason_code}${r.rejection_stage_key ? ` at ${stageName(r.rejection_stage_key)}` : ""}` : null,
        decisionReason: (r.decision_reason as string) ?? null,
        said: (((r.said as { t: string; k: string; s: string }[] | null) ?? []).filter((x) => x.t && !x.t.startsWith("Selected:") && !x.t.startsWith("Calculated"))).map((x) => ({ text: x.t, source: `${stageName(x.s)} · ${x.k.toUpperCase()}` })),
        profile,
        hasOpen: Boolean(r.has_open),
      };
    });
}

const STATUS_WORD: Record<string, string> = { rejected: "Not hired", withdrawn: "Withdrew", offer_declined: "Declined the offer", hired: "Hired", in_progress: "In the pipeline", on_hold: "On hold", archived: "Archived" };
export const outcomeWord = (s: string) => STATUS_WORD[s] ?? s;

export function whyNotHired(p: PoolPerson): string {
  if (p.status === "withdrawn") return `Withdrew at ${p.stageName}.${p.decisionReason ? ` ${p.decisionReason}` : ""}`;
  if (p.status === "offer_declined") return `Declined the offer.${p.decisionReason ? ` ${p.decisionReason}` : ""}`;
  if (p.status === "rejected") return `${p.rejection ?? `Not advanced at ${p.stageName}`}.${p.decisionReason ? ` “${p.decisionReason}”` : ""}`;
  return `Their application reached ${p.stageName}.`;
}

/* --------------------------------------------------------------- the pool */

export type OpenRole = { key: string; title: string; family: string; version: number; locations: string[]; headcount: number; hired: number; open: number };

export async function openRoles(): Promise<OpenRole[]> {
  const rows = (await db.execute(sql`
    select b.key, b.title, b.family, b.version, b.locations, b.headcount,
      (select count(*)::int from hire_applications a join hire_blueprints bb on bb.id = a.blueprint_id where bb.key = b.key and a.status = 'hired') as hired,
      (select count(*)::int from hire_applications a join hire_blueprints bb on bb.id = a.blueprint_id where bb.key = b.key and a.status in ('in_progress','on_hold')) as open
    from hire_blueprints b where b.status = 'published' order by b.title`)) as unknown as Raw[];
  return rows.map((r) => ({ key: String(r.key), title: String(r.title), family: String(r.family), version: Number(r.version), locations: (r.locations as string[]) ?? [], headcount: Number(r.headcount), hired: Number(r.hired), open: Number(r.open) }));
}

export type PoolMatch = PoolPerson & { match: string; notHired: string; quote: { text: string; source: string } | null; rank: number };

/** Strong past candidates not hired, for one open role, with why they match and why they were not hired. */
export async function silverMedallists(ctx: HireContext, role: OpenRole, now: number, minScore = 75): Promise<PoolMatch[]> {
  const all = await people(ctx, now);
  const skipped = await skippedFor(role.key);
  return all
    .filter((p) => !p.hasOpen && !skipped.has(p.candidateId) && p.status !== "hired")
    .filter((p) => p.poolStatus === "silver_medallist" || ((p.status === "rejected" || p.status === "withdrawn" || p.status === "offer_declined") && (p.overall ?? 0) >= minScore))
    .filter((p) => p.bpKey === role.key || p.family === role.family)
    .map((p) => {
      const parts: string[] = [];
      if (p.overall != null) parts.push(`averaged ${p.overall} across their scored stages for ${p.bpTitle} v${p.version}`);
      if (p.bpKey === role.key) parts.push("applied for this same role");
      else parts.push(`same role family (${p.family})`);
      if (p.location && role.locations.includes(p.location)) parts.push(`${p.location} is one of this role’s locations`);
      if (p.poolStatus === "silver_medallist") parts.push("marked a silver medallist");
      const quote = [...p.said].sort((a, b) => b.text.length - a.text.length)[0] ?? null;
      const rank = (p.overall ?? 0) + (p.bpKey === role.key ? 5 : 0) + (p.location && role.locations.includes(p.location) ? 5 : 0) + (p.poolStatus === "silver_medallist" ? 3 : 0);
      return { ...p, match: parts.join("; ").replace(/^./, (c) => c.toUpperCase()) + ".", notHired: whyNotHired(p), quote, rank };
    })
    .sort((a, b) => b.rank - a.rank);
}

/** Candidates somebody said are "not for this role" — read off the audit trail, which is where that decision lives. */
async function skippedFor(bpKey: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`select candidate_id from hire_audit where event_type = 'pool_skip' and after->>'blueprintKey' = ${bpKey}`)) as unknown as Raw[];
  return new Set(rows.map((r) => String(r.candidate_id)));
}

/* ------------------------------------------------------------------ search */

export type SearchFilters = { role?: string; location?: string; outcome?: string; recency?: string };
export type SearchHit = PoolPerson & { relevance: number; evidence: { text: string; source: string } | null };
export type SearchResult = { mode: "semantic" | "keyword"; reason?: string; hits: SearchHit[]; searched: number };

const docOf = (p: PoolPerson) =>
  [`${p.bpTitle}, ${p.family}.`, p.location ? `Location: ${p.location}.` : "", `Reached ${p.stageName}; ${outcomeWord(p.status)}.`, p.profile, ...p.said.map((s) => s.text)].filter(Boolean).join("\n");

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(["the", "and", "has", "have", "with", "who", "for", "that", "this", "from", "are", "was", "can", "not", "but", "they", "their", "someone", "somebody", "candidate", "candidates", "looking"]);

function keywordScore(q: string[], text: string): number {
  if (!q.length) return 0;
  const t = text.toLowerCase();
  let hit = 0;
  for (const w of q) if (t.includes(w.slice(0, Math.max(4, w.length - 2)))) hit++;
  return hit / q.length;
}

function bestEvidence(p: PoolPerson, q: string[]): { text: string; source: string } | null {
  if (!p.said.length) return p.profile ? { text: p.profile.slice(0, 220), source: "Profile" } : null;
  return [...p.said].sort((a, b) => keywordScore(q, b.text) - keywordScore(q, a.text) || b.text.length - a.text.length)[0];
}

export async function searchPool(ctx: HireContext, query: string, f: SearchFilters, now: number): Promise<SearchResult> {
  let pool = await people(ctx, now);
  if (f.role) pool = pool.filter((p) => p.bpKey === f.role);
  if (f.location) pool = pool.filter((p) => p.location === f.location);
  if (f.outcome) pool = pool.filter((p) => (f.outcome === "open" ? p.status === "in_progress" || p.status === "on_hold" : p.status === f.outcome));
  if (f.recency && f.recency !== "all") pool = pool.filter((p) => now - new Date(p.appliedAt).getTime() <= Number(f.recency) * 86_400_000);
  const q = words(query);
  if (!query.trim()) return { mode: "keyword", hits: [], searched: pool.length };

  const docs = pool.map((p) => ({ p, text: docOf(p) }));
  const hashes = docs.map((d) => contentHash(d.text));
  const cached = (await db.execute(sql`
    select content from hire_ai_outputs where kind = 'embedding' and content->>'model' = ${EMBEDDING_MODEL}
      and content->>'hash' in (select jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb))`)) as unknown as { content: { hash: string; vector: number[] } }[];
  const byHash = new Map(cached.map((c) => [c.content.hash, c.content.vector]));
  const missing = docs.map((d, i) => ({ d, h: hashes[i] })).filter((x) => !byHash.has(x.h));

  let reason: string | undefined;
  let semantic = true;
  if (missing.length) {
    const r = await embedTexts(missing.map((m) => m.d.text), ctx.user.id);
    if (r.ok) {
      const seen = new Set<string>();
      const values = missing
        .map((m, i) => ({ m, v: r.vectors[i] }))
        .filter((x) => x.v && !seen.has(x.m.h) && seen.add(x.m.h))
        .map((x) => {
          byHash.set(x.m.h, x.v);
          return { id: hid("hao"), kind: "embedding", applicationId: x.m.d.p.applicationId, content: { hash: x.m.h, model: EMBEDDING_MODEL, vector: x.v }, createdById: ctx.user.id };
        });
      for (let i = 0; i < values.length; i += 50) await db.insert(hireAiOutputs).values(values.slice(i, i + 50));
    } else {
      semantic = false;
      reason = r.reason;
    }
  }
  let qv: number[] | null = null;
  if (semantic) {
    const r = await embedTexts([query], ctx.user.id);
    if (r.ok) qv = r.vectors[0];
    else {
      semantic = false;
      reason = r.reason;
    }
  }

  const hits: SearchHit[] = docs
    .map((d, i) => {
      const v = byHash.get(hashes[i]);
      const relevance = semantic && qv && v ? cosineSimilarity(qv, v) : keywordScore(q, d.text);
      return { ...d.p, relevance, evidence: bestEvidence(d.p, q) };
    })
    .filter((h) => (semantic ? h.relevance > 0.2 : h.relevance > 0))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 50);
  return { mode: semantic ? "semantic" : "keyword", reason, hits, searched: pool.length };
}

export async function searchFilterOptions(ctx: HireContext) {
  const rows = (await db.execute(sql`
    select distinct b.key, b.title, a.location from hire_applications a join hire_blueprints b on b.id = a.blueprint_id where ${scopeWhere(ctx)}`)) as unknown as Raw[];
  const roles = [...new Map(rows.map((r) => [String(r.key), String(r.title)])).entries()].map(([key, title]) => ({ key, title })).sort((a, b) => a.title.localeCompare(b.title));
  const locations = [...new Set(rows.map((r) => r.location as string).filter(Boolean))].sort();
  return { roles, locations };
}

/** Is this candidate one this person can see? (For actions.) */
export async function candidateInScope(ctx: HireContext, candidateId: string) {
  const rows = (await db.execute(sql`
    select c.id, c.full_name, c.primary_phone, c.email, c.location, c.gender, c.age_band, c.preferred_language, c.do_not_contact, c.talent_pool_status,
      exists (select 1 from hire_applications o where o.candidate_id = c.id and o.status in ('in_progress','on_hold')) as has_open
    from hire_candidates c where c.id = ${candidateId}
      and exists (select 1 from hire_applications a where a.candidate_id = c.id and ${scopeWhere(ctx)})`)) as unknown as Raw[];
  return rows[0] ?? null;
}

