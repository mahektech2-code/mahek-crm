import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import { canLead, leadRecord, managerCalls } from "@/lib/services/lead-console-service";
import { VerifyScreen, type Finding } from "./verify-screen";

export const metadata = { title: "Verification — Lead — Sales Dashboard — MahekOne" };

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
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
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
  const findings: Finding[] = [
    {
      id: "competitor",
      label: "Whose product they use now",
      reported: record.competitor,
      lands: "competitor",
    },
    {
      id: "monthly_litres",
      label: "What they use in a month",
      reported: record.monthlyLitres != null ? `${record.monthlyLitres} litres` : null,
      lands: "monthly_requirement",
    },
    {
      id: "potential",
      label: "What they could be worth in a month",
      reported: record.potentialPaise != null ? money(record.potentialPaise) : null,
      lands: "potential",
    },
    {
      id: "required_product",
      label: "Which of ours they need",
      reported: record.requiredProductName,
      lands: null,
    },
    {
      id: "contact_person",
      label: "Who we ask for when we ring",
      reported: record.contactPerson,
      lands: null,
    },
    {
      id: "decision_maker",
      label: "Who signs off a purchase",
      reported: record.decisionMaker,
      lands: null,
    },
    {
      id: "credit_days",
      label: "The credit they want",
      reported: record.creditDaysWanted != null ? `${record.creditDaysWanted} days` : null,
      lands: null,
    },
    {
      id: "application",
      label: "What they will use it on",
      reported: record.application,
      lands: null,
    },
    {
      id: "customer_type",
      label: "What kind of business this is",
      reported: record.customerType,
      lands: null,
    },
  ];

  const detail =
    [record.companyName, record.city].filter(Boolean).join(" · ") || record.mobile || "";

  return (
    <VerifyScreen
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
