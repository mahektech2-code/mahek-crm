import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireBlueprints, hireCandidates, hireOffers, hireStageExecutions, users } from "@/db/schema";
import { stageByKey } from "@/lib/hire/blueprint-types";
import { HireNotPermitted, requireHireCap } from "@/lib/hire/access";
import { getApplication } from "@/lib/hire/services/core";
import { stamp } from "@/lib/format";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";
import { typeable } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * A CANDIDATE'S WITHDRAWAL, said before it is recorded.
 *
 * Withdrawing deletes nothing — Hire's record is append-only — but it is the
 * one closing act on a candidate that cannot be undone: a withdrawn
 * application is never resumed. And it closes the application without
 * touching what was already arranged for it. Interviews already booked stay
 * on the interviewer's calendar and list, and an offer stays as it stands;
 * both are what somebody recording a withdrawal assumes goes with it, so both
 * are said as "stays".
 * ------------------------------------------------------------------------- */

const OPEN = ["in_progress", "on_hold"];

export const hireWithdrawImpact: ImpactSource = {
  /* The act's own check: somebody who works the pipeline, and an application
     inside their scope — out of scope is "not on your list", never a report. */
  authorize: async (id) => {
    const ctx = await requireHireCap();
    if (!(ctx.can("addCandidate") || ctx.can("decide"))) throw new HireNotPermitted("This needs a Recruiter, Hiring Manager, HR Head or Admin.");
    if (!(await getApplication(ctx, id))) throw new HireNotPermitted("That candidate is not on your list.");
  },

  async report(id) {
    const [x] = await db
      .select({ app: hireApplications, name: hireCandidates.fullName, role: hireBlueprints.title, def: hireBlueprints.definition })
      .from(hireApplications)
      .innerJoin(hireCandidates, eq(hireCandidates.id, hireApplications.candidateId))
      .innerJoin(hireBlueprints, eq(hireBlueprints.id, hireApplications.blueprintId))
      .where(eq(hireApplications.id, id));
    if (!x) return null;
    const stageName = (key: string) => stageByKey(x.def, key)?.name ?? key;
    const [booked, offers] = await Promise.all([
      db
        .select({ stage: hireStageExecutions.stageKey, at: hireStageExecutions.scheduledAt, who: users.name })
        .from(hireStageExecutions)
        .leftJoin(users, eq(users.id, hireStageExecutions.conductedById))
        .where(
          and(
            eq(hireStageExecutions.applicationId, id),
            isNull(hireStageExecutions.supersededById),
            inArray(hireStageExecutions.status, ["scheduled", "in_progress"]),
          ),
        )
        .orderBy(asc(hireStageExecutions.scheduledAt)),
      db
        .select({ status: hireOffers.status })
        .from(hireOffers)
        .where(and(eq(hireOffers.applicationId, id), inArray(hireOffers.status, ["draft", "issued", "accepted"]))),
    ]);
    const items: ImpactItem[] = [
      {
        app: "Hire",
        label: many(booked.length, "interview still booked", "interviews still booked"),
        effect: "kept",
        count: booked.length,
        examples: booked.map((b) => [stageName(b.stage), b.at ? stamp(b.at) : null, b.who].filter(Boolean).join(" · ")),
        note: "Withdrawing does not cancel them: they stay on the interviewer’s calendar and list. Tell the interviewer.",
      },
      {
        app: "Hire",
        label: many(offers.length, "offer still standing", "offers still standing"),
        effect: "kept",
        count: offers.length,
        examples: offers.map((o) => o.status),
        note: "The offer keeps its status — record its outcome on the offer itself.",
      },
    ];
    return {
      title: `${x.name}’s application for ${x.role} (at ${stageName(x.app.stageKey)})`,
      verb: "Withdraw",
      confirmWord: typeable(x.name, "WITHDRAW"),
      items: present(items),
      /* The act's own refusal, before the button rather than after it. */
      blockers: OPEN.includes(x.app.status) ? [] : ["This application is already closed."],
    };
  },
};
