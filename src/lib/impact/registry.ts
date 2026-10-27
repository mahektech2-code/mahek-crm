import "server-only";
import { err, ok, type Err, type Result } from "@/lib/result";
import { LEADS_AND_ERP_SOURCES } from "./kinds/leads-and-erp";
import { PRICING_AND_PEOPLE_SOURCES } from "./kinds/pricing-and-people";
import {
  impactFingerprint,
  typedMatches,
  type ImpactConfirmation,
  type ImpactReport,
} from "./types";

/* ---------------------------------------------------------------------------
 * ONE SOURCE PER KIND OF RECORD, and the same source answers twice: once for
 * the modal (`impactReport`) and once inside the act (`confirmImpact`), so
 * what a person was shown and what the act checks cannot be two readings.
 *
 * A source is loaded lazily — each file reaches into its own app's tables,
 * and a holiday's delete has no reason to load the price-list queries.
 * ------------------------------------------------------------------------- */

export type ImpactBody = Omit<ImpactReport, "kind" | "id" | "fingerprint">;

export type ImpactSource = {
  /**
   * Who may SEE the report — the same narrowing the act applies, called before
   * the modal is answered. It throws (as `requireCapability` does) to refuse.
   * The act re-checks its own permission; this keeps the modal from being a
   * way to read records a person could not otherwise open.
   */
  authorize: (id: string) => Promise<void>;
  /** The report, or null where the record does not exist (or no longer does). */
  report: (id: string) => Promise<ImpactBody | null>;
};

const SOURCES: Record<string, () => Promise<ImpactSource>> = {
  holiday: () => import("./kinds/holiday").then((m) => m.holidayImpact),
  ...PRICING_AND_PEOPLE_SOURCES,
  ...LEADS_AND_ERP_SOURCES,
};

/** Every kind a modal may ask about — for the test that each has a source file. */
export const IMPACT_KINDS = Object.keys(SOURCES);

async function sourceFor(kind: string): Promise<ImpactSource | null> {
  const load = SOURCES[kind];
  return load ? load() : null;
}

function finish(kind: string, id: string, body: ImpactBody): ImpactReport {
  /* Biggest effect first: what is deleted, then unlinked, changed, off the
     phones, and what stays last — the order somebody reads a warning in. */
  const order = { deleted: 0, unlinked: 1, changed: 2, phones: 3, kept: 4 } as const;
  const items = body.items
    .filter((i) => i.count > 0 || i.effect === "kept")
    .sort((a, b) => order[a.effect] - order[b.effect] || b.count - a.count);
  const base = { ...body, kind, id, items };
  return { ...base, fingerprint: impactFingerprint(base) };
}

/** The report the modal shows. Refuses where the person may not see the record. */
export async function impactReport(kind: string, id: string): Promise<Result<ImpactReport>> {
  const source = await sourceFor(kind);
  if (!source) return err(`Nothing knows what deleting a "${kind}" affects.`, "validation");
  try {
    await source.authorize(id);
  } catch (e) {
    return err(e instanceof Error ? e.message : "You may not see this.", "not_permitted");
  }
  const body = await source.report(id);
  if (!body) return err("That record no longer exists — somebody may have removed it already.", "not_found");
  return ok(finish(kind, id, body));
}

/**
 * Inside the act, before it writes: the confirmation names the picture the
 * person saw, and that picture still has to be the true one.
 *
 * Answers null when the act may go ahead, and the refusal otherwise —
 * `conflict` where something moved since the modal opened, which the modal
 * answers by showing the new picture.
 */
export async function confirmImpact(
  kind: string,
  id: string,
  confirmation: ImpactConfirmation | null | undefined,
): Promise<Err | null> {
  if (!confirmation) {
    return err("Check what this affects and confirm it first.", "validation");
  }
  const source = await sourceFor(kind);
  if (!source) return err(`Nothing knows what deleting a "${kind}" affects.`, "validation");
  const body = await source.report(id);
  if (!body) return err("That record no longer exists — somebody may have removed it already.", "not_found");
  const report = finish(kind, id, body);
  if (report.blockers.length) return err(report.blockers[0], "rule_violation");
  if (report.fingerprint !== confirmation.fingerprint) {
    return err(
      "Something changed since you opened this — check the new list of what it affects and confirm again.",
      "conflict",
    );
  }
  if (!typedMatches(confirmation.typed, report.confirmWord)) {
    return err(`Type "${report.confirmWord}" to confirm.`, "validation");
  }
  return null;
}
