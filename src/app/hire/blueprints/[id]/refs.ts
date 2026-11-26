import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { StudioRefs } from "./sections";

/**
 * The titles behind the published keys `blueprintRefs` returns, and the people
 * who hold Hire's Trainer role — what the editor's pickers offer.
 */
export async function studioRefs(keys: { planKeys: string[]; templateKeys: string[]; trackKeys: string[] }): Promise<StudioRefs> {
  const rows = (await db.execute(sql`
    select 'plan' as k, key, title from hire_incentive_plans where status = 'published'
    union all select 'template', key, title from hire_doc_templates where status = 'published'
    union all select 'track', t.key, t.title from training_tracks t join training_track_versions v on v.track_id = t.id where v.status = 'published'`)) as unknown as { k: string; key: string; title: string }[];
  const pick = (k: string, allowed: string[]) => rows.filter((r) => r.k === k && allowed.includes(r.key)).map((r) => ({ key: r.key, title: r.title }));
  const trainerIds = (await db.execute(sql`select user_id from hire_user_roles where role = 'trainer'`)) as unknown as { user_id: string }[];
  const trainers = trainerIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, trainerIds.map((t) => t.user_id)))
    : [];
  return { plans: pick("plan", keys.planKeys), templates: pick("template", keys.templateKeys), tracks: pick("track", keys.trackKeys), trainers: trainers.sort((a, b) => a.name.localeCompare(b.name)) };
}
