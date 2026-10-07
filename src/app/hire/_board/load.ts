import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { nowMs } from "@/lib/format";
import { seesScores, type HireContext } from "@/lib/hire/access";
import type { BlueprintDefinition } from "@/lib/hire/blueprint-types";
import { whoCan } from "@/lib/hire/roles";
import { boardRows } from "@/lib/hire/services/pipeline";
import { hireStaff } from "@/lib/hire/services/schedule";
import type { BoardBlueprint, PipelineData } from "./types";

/** Everything the board and the table draw, in one load. */
export async function loadPipeline(ctx: HireContext): Promise<PipelineData> {
  const [rows, bps, staff] = await Promise.all([
    boardRows(ctx),
    db.execute(sql`select id, key, title, version, status, locations, definition from hire_blueprints where status in ('published','draft') or id in (select blueprint_id from hire_applications) order by title, version desc`) as unknown as Promise<Record<string, unknown>[]>,
    ctx.can("addCandidate") ? hireStaff() : Promise.resolve([]),
  ]);
  const blueprints: BoardBlueprint[] = bps.map((b) => ({
    id: String(b.id),
    key: String(b.key),
    title: String(b.title),
    version: Number(b.version),
    status: String(b.status),
    locations: (b.locations as string[]) ?? [],
    stages: (b.definition as BlueprintDefinition).stages.map((s) => ({ key: s.key, name: s.name, type: s.type, slaHours: s.slaHours })),
  }));
  return {
    rows,
    blueprints,
    staff,
    nowMs: nowMs(),
    me: { id: ctx.user.id, role: ctx.role, roleLabel: ctx.roleLabel },
    can: { override: ctx.can("override"), addCandidate: ctx.can("addCandidate"), seesScores: seesScores(ctx) },
    overrideWho: whoCan("override"),
  };
}
