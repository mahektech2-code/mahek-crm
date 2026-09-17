import { type LeadWorkspace } from "@/lib/lead-workspace";
import { leadAudit } from "@/lib/services/lead-oversight-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { AuditScreen } from "@/components/leads/oversight/audit/audit-screen";


/**
 * What was done to the funnel, and under whose hat.
 *
 * Every audited write in `actions/leads.ts`, `actions/lead-samples.ts` and
 * `actions/distributor-appointment.ts` already lands a row, and §Q's handover
 * lands one beside them; nothing here creates a record, it only reads the one
 * that exists. A decision nobody can look up later is a decision nobody can be
 * asked about, which is the opposite of why the table is written.
 *
 * **Paged with a keyset, never an offset.** The cursor is the instant and the
 * id together, taken from the last row of the page and carried in the URL —
 * an offset over a table this size drifts every time a row lands while
 * somebody is reading, and the symptom is a row appearing twice while another
 * appears not at all.
 *
 * The cursor arrives as an ISO STRING and is bound as one. A JS `Date` in a
 * raw template is serialised by asking Node to render it as text, which throws
 * inside the driver where no type check can see it — and takes the whole query
 * with it rather than the parameter.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ at?: string; id?: string }>;
}) {
  const params = await searchParams;

  /* Both halves or neither. A cursor with one of the two is a page somebody
     has hand-edited, and reading it would be paging on half a key. */
  const cursor = params.at && params.id ? { at: params.at, id: params.id } : null;

  const page = await leadAudit({ cursor });

  return (
    <>
      <LeadTabs workspace={workspace} />
      <AuditScreen workspace={workspace}
        rows={page.rows}
        total={page.total}
        nextCursor={page.nextCursor}
        onFirstPage={!cursor}
      />
    </>
  );
}
