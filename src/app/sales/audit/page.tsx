import { stamp } from "@/lib/format";
import { fieldAudit } from "@/lib/services/sales-service";
import { Cell, Empty, HeadCell, Row, ScreenHeader, Table } from "../parts";

export const metadata = { title: "Audit trail — Sales Dashboard — MahekOne" };

/** The action, in words somebody can read without knowing the key. */
const ACTIONS: Record<string, string> = {
  "mbos.approval.approved": "Approved a request",
  "mbos.approval.rejected": "Refused a request",
  "mbos.approval.partially_approved": "Approved part of a request",
  "mbos.journey.period": "Planned a run of days",
  "mbos.journey.plan": "Planned a day",
  "mbos.journey.delete": "Removed a day's plan",
};

/**
 * Every decision made in this console, with a name against it.
 *
 * It reads `audit_log`, the same table every other MahekOne decision writes to,
 * filtered to this app's actions — a second audit table would be a second
 * answer to "who did that", and the two would disagree the first time somebody
 * looked.
 *
 * What it shows is what was actually recorded. A decision writes its before and
 * after state, so a refusal carries the reason that was given and a plan
 * carries how many days it covered.
 */
export default async function Page() {
  const rows = await fieldAudit();

  return (
    <div className="p-6">
      <ScreenHeader
        title="Audit trail"
        subtitle="Every decision made in this console. It is the same audit log the rest of MahekOne writes to, filtered to the field — a second table would be a second answer to who did what."
      />

      {rows.length === 0 ? (
        <Empty
          title="Nothing has been decided yet"
          body="Approving a request, refusing one or publishing a route each write a row here with the name of whoever did it."
        />
      ) : (
        <Table
          minWidth={1080}
          head={
            <>
              <HeadCell width={200}>When</HeadCell>
              <HeadCell width={190}>Who</HeadCell>
              <HeadCell width={260}>What</HeadCell>
              <HeadCell>Detail</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell>{stamp(r.at)}</Cell>
              <Cell truncate={190}>
                {r.actorName ?? <span className="text-muted">The app</span>}
              </Cell>
              <Cell>{ACTIONS[r.action] ?? r.action.replace(/[._]/g, " ")}</Cell>
              <Cell truncate={520}>
                <span className="font-mono text-[12px] text-muted">{detail(r.afterState)}</span>
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

/**
 * The recorded state, as one readable line.
 *
 * Rendered from whatever was stored rather than from a per-action formatter:
 * an action added later still reads, which is the failure direction worth
 * having on a log nobody maintains.
 */
function detail(state: unknown): string {
  if (!state || typeof state !== "object") return "—";
  return Object.entries(state as Record<string, unknown>)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}
