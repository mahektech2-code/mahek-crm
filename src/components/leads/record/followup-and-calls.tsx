import { Card } from "@/components/leads/record/record-chrome";
import { shortDate } from "@/lib/format";
import type { LeadCallEntry, UpcomingFollowUp } from "@/lib/services/lead-followup-service";

const OUTCOME_WORDS: Record<string, string> = {
  spoke_collected: "Spoke — information collected",
  spoke_callback: "Spoke — asked for a call back",
  no_answer: "No answer",
  not_interested: "Not interested",
  wrong_number: "Wrong number",
};

function outcomeWords(c: LeadCallEntry): string {
  if (c.detailOutcome && OUTCOME_WORDS[c.detailOutcome]) return OUTCOME_WORDS[c.detailOutcome];
  return c.outcome ? c.outcome.replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase()) : "Call";
}

/**
 * The next call owed on this lead, read from the existing reminders — the same
 * rows `/crm/reminders` lists — and the lead's own owner by name.
 */
export function UpcomingFollowUpCard({ followUps, day }: { followUps: UpcomingFollowUp[]; day: string }) {
  return (
    <Card title="Upcoming follow-up">
      {followUps.length === 0 ? (
        <div className="text-[13px] text-muted">No follow-up is scheduled on this lead.</div>
      ) : (
        <ul className="flex flex-col divide-y divide-divider">
          {followUps.map((f) => {
            const overdue = f.dueDate < day;
            return (
              <li key={f.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">{f.note}</div>
                  <div className="text-[12px] text-muted">
                    For {f.assignedToName}
                    {f.rescheduleCount ? ` · moved ${f.rescheduleCount} ${f.rescheduleCount === 1 ? "time" : "times"}` : ""}
                  </div>
                </div>
                <div className={`text-sm font-semibold ${overdue ? "text-danger" : "text-ink"}`}>
                  {shortDate(f.dueDate)}
                  {overdue ? " · overdue" : f.dueDate === day ? " · today" : ""}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * The saved call behind a Timeline entry: its number, outcome, remarks and
 * next follow-up. Drawn UNDER the existing entry — the entry is not duplicated.
 */
export function CallDetail({ call: c }: { call: LeadCallEntry }) {
  return (
    <div className="mt-1 rounded-[4px] bg-canvas px-2.5 py-1.5 text-[12.5px] text-body">
      <div className="font-medium text-ink">
        {c.callNumber ? `Call ${c.callNumber} · ` : ""}
        {outcomeWords(c)}
      </div>
      {c.notes ? <div className="whitespace-pre-wrap">{c.notes}</div> : null}
      {c.nextDate || c.nextAction ? (
        <div>
          <span className="text-muted">Next follow-up: </span>
          {c.nextAction ? <span className="font-medium text-ink">{c.nextAction}</span> : null}
          {c.nextDate ? <span className="text-muted"> · {shortDate(c.nextDate)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
