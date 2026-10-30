import { Card } from "@/components/leads/record/record-chrome";
import { shortDate, stamp } from "@/lib/format";
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

/** Every recorded call at this lead, newest first. Read-only; the rows are the `calls` table's own. */
export function CallHistoryCard({ calls }: { calls: LeadCallEntry[] }) {
  return (
    <Card title="Call history">
      {calls.length === 0 ? (
        <div className="text-[13px] text-muted">No call has been recorded on this lead yet.</div>
      ) : (
        <ol className="flex flex-col divide-y divide-divider">
          {calls.map((c) => (
            <li key={c.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-semibold text-ink">
                  {c.callNumber ? `Call ${c.callNumber} · ` : ""}
                  {outcomeWords(c)}
                </div>
                <div className="font-mono text-[11px] text-muted">
                  {stamp(c.at)} · {c.byName}
                </div>
              </div>
              {c.notes ? <div className="mt-1 text-[13.5px] whitespace-pre-wrap text-body">{c.notes}</div> : null}
              {c.nextDate || c.nextAction ? (
                <div className="mt-1 text-[13px]">
                  <span className="text-muted">Next follow-up: </span>
                  {c.nextAction ? <span className="font-medium text-ink">{c.nextAction}</span> : null}
                  {c.nextDate ? <span className="text-muted"> · {shortDate(c.nextDate)}</span> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
