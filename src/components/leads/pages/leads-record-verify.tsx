import { type LeadWorkspace } from "@/lib/lead-workspace";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/format";
import { VERIFICATION_FINDINGS } from "@/lib/lead-labels";
import { today } from "@/lib/recompute";
import { canLead, leadRecord, managerCalls } from "@/lib/services/lead-console-service";
import { VerifyScreen, type Finding } from "@/components/leads/record/verify/verify-screen";


/**
 * §8 — the verification call at full size, for the form a modal cannot hold.
 *
 * Nine findings and twelve questions is a scroll inside a modal, and this is
 * the one form in the funnel somebody fills in while the customer is on the
 * line. The modal on the record stays — a manager who only wants the twelve
 * should not have to leave the page — and both write through the same
 * `recordLeadValidationCall`, so the two doors cannot report different
 * histories for one lead.
 *
 * **The findings are assembled HERE, formatted.** Money is paise everywhere in
 * MahekOne and becomes rupees only in `lib/format.ts` on the way to a screen,
 * so the potential is turned into words on the server rather than shipped as an
 * integer for a client to divide by a hundred. The same reasoning as every
 * other figure on this dashboard.
 *
 * **`lands` names the column, or says there is none.** Three of these nine have
 * a column on `mbos_lead_validations` — the competitor, the monthly
 * requirement, the growth in it — and six do not. Guessing a column for the
 * other six would write the office's reading over the salesman's own, which is
 * the one thing §8 must never do, so they are marked null and the screen states
 * the gap in words.
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
     two are one answer on purpose — see the record page. */
  if (!record) notFound();

  const calls = await managerCalls(id);

  /*
   * A finding with nothing recorded against it is still LISTED. "He did not
   * establish what they use in a month" is a fact about the visit and one of
   * the things this call exists to find out; dropping the row would make a
   * report with six blanks look like a report with three answers.
   */
  /*
   * BUILT FROM `VERIFICATION_FINDINGS`, never listed again here.
   *
   * The nine ids, their words and which column each lands in are one constant
   * now, because three things read them: this page, the verify screen's rows,
   * and the action that validates a correction on its way to
   * `lead_verification_corrections`. Typed out here as well, a tenth finding
   * added to the screen and not to the validator would be a correction
   * silently dropped — which reads afterwards as a manager who never bothered.
   *
   * What stays here is the only part that is about THIS lead: what the
   * salesman actually reported, formatted. Money is paise everywhere in this
   * codebase and litres are litres, so the formatting belongs on the server
   * beside the record rather than in the client that draws the row.
   */
  const reported: Record<string, string | null> = {
    competitor: record.competitor,
    monthly_litres: record.monthlyLitres != null ? `${record.monthlyLitres} litres` : null,
    potential: record.potentialPaise != null ? money(record.potentialPaise) : null,
    required_product: record.requiredProductName,
    contact_person: record.contactPerson,
    decision_maker: record.decisionMaker,
    credit_days: record.creditDaysWanted != null ? `${record.creditDaysWanted} days` : null,
    application: record.application,
    customer_type: record.customerType,
  };

  const findings: Finding[] = VERIFICATION_FINDINGS.map((f) => ({
    id: f.id,
    label: f.label,
    reported: reported[f.id] ?? null,
    lands: f.lands,
  }));

  const detail =
    [record.companyName, record.city].filter(Boolean).join(" · ") || record.mobile || "";

  return (
    <VerifyScreen workspace={workspace}
      /* Keyed on the lead so moving between two of these remounts with a blank
         form rather than having an effect clear it — the React Compiler rules
         are on, and a half-cleared verification form is a call recorded against
         the wrong shop. */
      key={record.customerId}
      customerId={record.customerId}
      leadName={record.name}
      detail={detail}
      salesType={record.salesType}
      stage={record.stage}
      findings={findings}
      priorCalls={calls}
      canVerify={await canLead(user, "lead.verify")}
    />
  );
}
