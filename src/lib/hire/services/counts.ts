import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { scopeWhere, type HireContext } from "../access";
import type { NavCounts } from "@/app/hire/_ui/hire-shell";

/**
 * The sidebar badges. Each counts exactly what its screen lists, from the
 * same scope, so a badge and the page behind it cannot disagree.
 */
export async function navCounts(ctx: HireContext): Promise<NavCounts> {
  const [r] = (await db.execute(sql`
    select
      (select count(*)::int from hire_answers w
         join hire_stage_executions x on x.id = w.execution_id
         join hire_applications a on a.id = x.application_id
        where ${scopeWhere(ctx)} and x.superseded_by_id is null and w.superseded_by_id is null
          and w.ai_score is not null and w.confirmed_at is null) as review,
      (select count(distinct x.id)::int from hire_answers w
         join hire_stage_executions x on x.id = w.execution_id
         join hire_applications a on a.id = x.application_id
        where ${scopeWhere(ctx)} and x.superseded_by_id is null and w.superseded_by_id is null
          and w.ai_score is not null and w.confirmed_at is null and w.created_at < now() - interval '24 hours') as review_over,
      (select count(*)::int from hire_rejection_proposals p join hire_applications a on a.id = p.application_id
        where ${scopeWhere(ctx)} and p.status = 'open') as proposals,
      (select count(*)::int from hire_rejection_proposals p join hire_applications a on a.id = p.application_id
        where ${scopeWhere(ctx)} and p.status = 'open' and p.window_ends_at < now()) as proposals_over,
      (select count(*)::int from hire_applications a join hire_blueprints b on b.id = a.blueprint_id
        where ${scopeWhere(ctx)} and a.status = 'in_progress'
          and exists (select 1 from jsonb_array_elements(b.definition->'stages') s where s->>'key' = a.stage_key and s->>'type' = 'decision_gate')) as gates,
      (select count(*)::int from hire_applications a
        where ${scopeWhere(ctx)} and a.status = 'in_progress' and (a.duplicate->>'status') = 'open') as dups
  `)) as unknown as Record<string, number>[];
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    review: { n: n("review"), over: n("review_over") > 0 },
    decisions: { n: n("proposals") + n("gates"), over: n("proposals_over") > 0 },
    tasks: { n: n("dups") + n("proposals") + n("review") + n("gates"), over: n("proposals_over") > 0 },
  };
}
