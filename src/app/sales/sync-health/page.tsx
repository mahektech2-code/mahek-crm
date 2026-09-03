import Link from "next/link";
import { nowMs, stamp } from "@/lib/format";
import { getConfig } from "@/lib/config/store";
import { syncHealth } from "@/lib/services/sales-service";
import { Banner, Cell, Empty, HeadCell, MetricRow, Pill, Row, ScreenHeader, Table } from "../parts";

export const metadata = { title: "Sync health — Sales Dashboard — MahekOne" };

/**
 * Whose handset has gone quiet, and whose last pushes were refused.
 *
 * **This cannot show a stuck outbox, and says so rather than guessing.** An
 * item still waiting in the queue on the phone has never reached the server —
 * that is what "queued" means — so there is nothing here for it to leave a
 * trace in. `mbos_sync_receipts` only ever holds what the server actually
 * SAW and accepted, rejected or found in conflict; a `retry` is deliberately
 * never stored, because it is the one answer that must not stick (see the
 * comment on `storeReceipt`). What this screen answers instead is narrower
 * and just as real: when each handset last spoke at all, and what the office
 * has actually refused from it in the last week.
 */
export default async function Page() {
  const [rows, config] = await Promise.all([syncHealth(), getConfig()]);
  const quietHours = config["mbos.sync.quietHours"];

  const now = nowMs();
  const quietMs = quietHours * 60 * 60 * 1000;
  const quiet = rows.filter((r) => !r.lastSeenAt || now - r.lastSeenAt.getTime() > quietMs);
  const refused = rows.filter((r) => r.rejected7d > 0 || r.unresolvedConflicts > 0);
  const totalRejected = rows.reduce((sum, r) => sum + r.rejected7d, 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Sync health"
        subtitle="When each handset last reached MahekOne, and what it has sent that the server refused or flagged. Not a queue depth — nobody's phone reports that."
      />

      <Banner
        tone="info"
        title="This is not an outbox viewer"
        body={`An item still queued on a phone has never reached the server, so there is nothing here for it to show — that view lives on the handset itself, in Sync & rejections. What this screen answers is when a device last spoke at all, and what the office has refused or flagged from it in the last 7 days. A handset quiet for more than ${quietHours} hours is called out below either way.`}
      />

      <MetricRow
        metrics={[
          {
            label: "Quiet handsets",
            value: String(quiet.length),
            sub: `no signal in ${quietHours}h`,
            tone: quiet.length ? "warn" : undefined,
          },
          {
            label: "Rejected in 7 days",
            value: String(totalRejected),
            tone: totalRejected ? "danger" : undefined,
          },
          {
            label: "Unresolved conflicts",
            value: String(rows.reduce((sum, r) => sum + r.unresolvedConflicts, 0)),
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty title="Nobody holds the Salesman App" body="The field team is whoever has been granted it." />
      ) : (
        <Table
          minWidth={1180}
          head={
            <>
              <HeadCell width={200}>Salesman</HeadCell>
              <HeadCell width={220}>Handset</HeadCell>
              <HeadCell width={190}>Last spoke</HeadCell>
              <HeadCell width={140} align="right">
                Rejected, 7d
              </HeadCell>
              <HeadCell width={160} align="right">
                Conflicts, 7d
              </HeadCell>
              <HeadCell width={170} align="right">
                Unresolved
              </HeadCell>
              <HeadCell>State</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => {
            const isQuiet = quiet.includes(r);
            return (
              <Row key={r.salesmanId} striped={i % 2 === 1}>
                <Cell truncate={200}>
                  <Link
                    href={`/sales/people/${r.salesmanId}`}
                    className="font-medium text-ink no-underline hover:underline"
                  >
                    {r.salesmanName}
                  </Link>
                </Cell>
                <Cell truncate={220}>
                  {r.model ?? r.platform ?? <span className="text-muted">No handset bound</span>}
                </Cell>
                <Cell>
                  {r.lastSeenAt ? (
                    stamp(r.lastSeenAt)
                  ) : (
                    <span className="text-muted">Never</span>
                  )}
                </Cell>
                <Cell align="right">
                  {r.rejected7d > 0 ? (
                    <span className="text-danger font-medium">{r.rejected7d}</span>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </Cell>
                <Cell align="right">
                  {r.conflicted7d > 0 ? r.conflicted7d : <span className="text-muted">0</span>}
                </Cell>
                <Cell align="right">
                  {r.unresolvedConflicts > 0 ? (
                    <span className="text-danger font-medium">{r.unresolvedConflicts}</span>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </Cell>
                <Cell>
                  {isQuiet ? (
                    <Pill tone="warn">Quiet</Pill>
                  ) : refused.includes(r) ? (
                    <Pill tone="danger">Being refused</Pill>
                  ) : (
                    <Pill tone="success">Healthy</Pill>
                  )}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}
    </div>
  );
}
