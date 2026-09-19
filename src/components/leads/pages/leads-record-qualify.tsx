import { type LeadWorkspace } from "@/lib/lead-workspace";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { checklistFor, gateTo } from "@/lib/engines/lead-gates";
import { nextStage } from "@/lib/engines/lead-ladder";
import { canLead, gateInputFor, leadRecord } from "@/lib/services/lead-console-service";
import { distributorProfileFor } from "@/lib/services/lead-record-service";
import { QualifyScreen, type QualifyValues } from "@/components/leads/record/qualify/qualify-screen";


/**
 * §9 §11 — the checklist at full size, for the case a modal cannot hold.
 *
 * Twelve conditions is a scroll inside a modal and thirty is a scroll inside a
 * scroll, which is why the specification gives this its own route. Everything
 * else about it is the same: the same `checklistFor` list, the same
 * `saveLeadQualification` and `saveProspectFields` and `saveDistributorProfile`
 * actions, the same capability checked in each of them.
 *
 * **The verdict is computed HERE and passed down.** `gateTo` is pure and could
 * run in the browser, but the input it takes is half the record and shipping it
 * to draw a banner is how a page comes to carry a customer's whole ledger in
 * its payload. The screen receives an answer and never re-derives one.
 *
 * **Which rung this checklist OPENS is asked of the ladder, not written down.**
 * The qualification conditions gate `sample_trial` on the two shop ladders and
 * `management_review` on the distributor one, and a constant saying so here
 * would be a fourth place the ladder is restated.
 */
export async function Body({
  workspace,
  params,
}: {
  workspace: LeadWorkspace;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const day = await today();
  const user = await requireUser();

  const record = await leadRecord(id, day);
  /* Null is both "no such lead" and "not in this manager's territory", and the
     two are deliberately one answer: a 404 that told them apart would make the
     URL a way to find out whose book an id belongs to. */
  if (!record) notFound();

  const profile =
    record.salesType === "distributor" ? await distributorProfileFor(id) : null;

  const conditions = checklistFor(record.salesType, "qualification");
  const opensRung = nextStage("qualification", record.salesType);
  /* §5.3 — `freshDays` is required rather than defaulted, because a caller
     that left it out drew a rail saying the sample rung was open on a lead the
     action would then refuse. The configured window, read once. */
  const config = await getConfig();
  const verdict = opensRung
    ? gateTo(gateInputFor(record, config["leads.figuresFreshDays"]), opensRung)
    : null;

  /*
   * Every stored answer on one map, keyed the way the ACTION that writes it
   * keys it. The §6 columns carry `saveProspectFields`' own names, the ticks
   * carry their condition id, and the distributor profile is merged by the
   * screen. Flattening here rather than in the browser keeps the three tables
   * an implementation detail of where an answer lands.
   */
  const values: QualifyValues = {
    gstin: record.gstin,
    monthlyLitres: record.monthlyLitres,
    potentialPaise: record.potentialPaise,
    requiredProductId: record.requiredProductId,
    competitor: record.competitor,
    creditDaysWanted: record.creditDaysWanted,
    decisionMaker: record.decisionMaker,
    application: record.application,
    ...(record.qualification ?? {}),
  };

  const detail =
    [record.companyName, record.city].filter(Boolean).join(" · ") || record.mobile || "";

  return (
    <QualifyScreen workspace={workspace}
      /* Keyed on the lead, so navigating between two of these remounts with
         fresh draft state rather than having an effect reset it — the React
         Compiler rules are on and this is the pattern every dialog here uses. */
      key={record.customerId}
      customerId={record.customerId}
      leadName={record.name}
      detail={detail}
      salesType={record.salesType}
      stage={record.stage}
      conditions={conditions}
      verdict={verdict}
      opensRung={opensRung}
      values={values}
      profile={profile}
      requiredProductName={record.requiredProductName}
      canWork={await canLead(user, "lead.work")}
      /*
       * §5.3 — the manager's standing verdict, passed whole rather than as four
       * props. Drawn for everybody, because a salesman blocked by something he
       * cannot see is blocked by nothing he can act on.
       */
      review={{
        verdict: record.qualificationReview,
        note: record.qualificationReviewNote,
        at: record.qualificationReviewedAt,
        byName: record.qualificationReviewedByName,
      }}
      /*
       * `lead.verify` — the sales manager's own judgement about a lead,
       * recorded on the lead, which the salesman working it may not make about
       * his own work. Resolved here and checked again in
       * `reviewLeadQualification`: a server action is a URL and an undrawn
       * button is a fact about a component.
       */
      canReview={await canLead(user, "lead.verify")}
    />
  );
}
