import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Tx } from "./access-writes";

/* ---------------------------------------------------------------------------
 * EVERYTHING A PERSON HOLDS, AS ONE PICTURE — written on both sides of every
 * access change, so the audit can answer "what did she hold on the 1st?" and
 * "what exactly did that save change?".
 *
 * Before this the access audit row carried one sentence ("granted erp 12/40,
 * ERP powers 2 → 3") and no before state at all: a mistaken save could be
 * read but not undone, because nothing said what had been there.
 *
 * Apps with their level and screens (an empty list means every screen — the
 * "no module rows" rule), ERP / HRMS / Tasks powers, the ERP designation, the
 * Hire role and the factory place. Sorted, so two snapshots of the same
 * access compare equal as JSON.
 * ------------------------------------------------------------------------- */

export type AccessSnapshot = {
  apps: { app: string; level: string; screens: string[] | "all" }[];
  erpPowers: string[];
  hrmsPowers: string[];
  taskPowers: string[];
  erpDesignation: string | null;
  hireRole: string | null;
  factory: { areas: string[]; crews: Record<string, string> } | null;
};

export async function accessSnapshot(userId: string, q: Tx | typeof db = db): Promise<AccessSnapshot> {
  const [row] = (await q.execute(sql`
    select
      coalesce((select json_agg(json_build_object(
                  'app', a.app::text,
                  'level', coalesce(a.role, 'associate'),
                  'screens', coalesce((select json_agg(m.module order by m.module) from app_module_access m
                                        where m.user_id = a.user_id and m.app = a.app), '"all"'::json))
                order by a.app::text)
                 from app_access a where a.user_id = ${userId}), '[]'::json) as apps,
      coalesce((select json_agg(p.power order by p.power) from erp_user_powers p where p.user_id = ${userId}), '[]'::json) as "erpPowers",
      coalesce((select json_agg(p.power order by p.power) from hrms_user_powers p where p.user_id = ${userId}), '[]'::json) as "hrmsPowers",
      coalesce((select json_agg(p.power order by p.power) from task_user_powers p where p.user_id = ${userId}), '[]'::json) as "taskPowers",
      (select d.name from erp_user_designations x join erp_designations d on d.id = x.designation_id where x.user_id = ${userId} limit 1) as "erpDesignation",
      (select h.role from hire_user_roles h where h.user_id = ${userId} limit 1) as "hireRole",
      (select json_build_object(
                'areas', coalesce(to_json(s.areas), json_build_array(s.area)),
                'crews', coalesce((select json_object_agg(t.proc, t.role) from factory_team_defaults t where t.user_id = s.user_id), '{}'::json))
         from factory_staff s where s.user_id = ${userId}) as factory
  `)) as unknown as AccessSnapshot[];
  return {
    apps: row?.apps ?? [],
    erpPowers: row?.erpPowers ?? [],
    hrmsPowers: row?.hrmsPowers ?? [],
    taskPowers: row?.taskPowers ?? [],
    erpDesignation: row?.erpDesignation ?? null,
    hireRole: row?.hireRole ?? null,
    factory: row?.factory ?? null,
  };
}
