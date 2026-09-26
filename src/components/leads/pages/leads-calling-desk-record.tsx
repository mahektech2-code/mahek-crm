import { notFound } from "next/navigation";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { addDays, onOrAfterWorkingDay, type BusinessDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { deskLeadRecord } from "@/lib/services/lead-calling-desk-service";
import { canLead } from "@/lib/services/lead-console-service";
import { RecordScreen } from "@/components/leads/calling-desk/record-screen";

/**
 * One lead, on the Telecaller's own record.
 *
 * It sits BESIDE `/crm/leads/[id]` and replaces nothing: that record is the
 * Sales Manager's and the salesman's and stays exactly as it is, and this is the
 * desk's view of the same lead — same row, same columns, drawn as Version 6.
 *
 * The read narrows through the request's own scope, so a lead that is not the
 * caller's answers 404, the same answer as one that does not exist. The three
 * things the screen may not compute itself — the business day, the default day
 * for the next call, and whether this person may write — are resolved here.
 */
export async function Body({
  workspace,
  params,
}: {
  workspace: LeadWorkspace;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [day, user, config] = await Promise.all([today(), requireUser(), getConfig()]);

  const lead = await deskLeadRecord(id, day);
  if (!lead) notFound();

  const canWork = await canLead(user, "lead.work");

  return (
    <RecordScreen
      lead={lead}
      canWork={canWork}
      today={day}
      defaultNextDate={onOrAfterWorkingDay(addDays(day as BusinessDate, 2), {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      })}
      prospectReasons={config["leads.prospectReasons"]}
      lostReasons={config["leads.lostReasons"]}
      sampleReasons={config["leads.sampleReasons"]}
      orderBlockers={config["leads.orderBlockers"]}
      base={leadHref(workspace, "leads/calling-desk")}
    />
  );
}
