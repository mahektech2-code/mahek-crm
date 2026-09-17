import { nowMs, stamp } from "@/lib/format";
import { getConfig } from "@/lib/config/store";
import { syncHealth } from "@/lib/services/sales-service";
import {
  Banner,
  Cell,
  Empty,
  EntityLink,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "@/components/console/parts";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";

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
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const [rows, config] = await Promise.all([syncHealth(), getConfig()]);
  const quietHours = config["mbos.sync.quietHours"];

  const now = nowMs();
  const quietMs = quietHours * 60 * 60 * 1000;
  const quiet = rows.filter((r) => !r.lastSeenAt || now - r.lastSeenAt.getTime() > quietMs);
  const refused = rows.filter((r) => r.rejected7d > 0 || r.unresolvedConflicts > 0);
  const totalRejected = rows.reduce((sum, r) => sum + r.rejected7d, 0);

  /* Sorting is DISPLAY ONLY. The three figures above the table are counted
     over every handset the scope allows and never over the sorted copy —
     re-ordering a list changes where a row sits, not whether it is in the set,
     and a "quiet handsets" count that moved when somebody clicked a column
     would be the screen disagreeing with itself. The quiet and refused sets
     are the same rows by reference, so `includes` below is unaffected by the
     copy `sortRows` returns. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/sync-health", sort, key)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

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
              {head("name", "Salesman", 200)}
              {/* The handset column is the model string as the phone reported
                  it, and one manufacturer spells its own devices three ways —
                  so an alphabetical pass over it groups nothing anybody asked
                  about. The state column is the other two together, drawn as
                  pills; sorting by them is sorting by "quiet, then refused,
                  then healthy", which is exactly what the two numeric columns
                  beside it already answer with a figure. */}
              <HeadCell width={220}>Handset</HeadCell>
              {head("spoke", "Last spoke", 190)}
              {head("rejected", "Rejected, 7d", 140, "right")}
              {head("conflicted", "Conflicts, 7d", 160, "right")}
              {head("unresolved", "Unresolved", 170, "right")}
              <HeadCell>State</HeadCell>
            </>
          }
        >
          {sorted.map((r, i) => {
            const isQuiet = quiet.includes(r);
            return (
              <Row key={r.salesmanId} striped={i % 2 === 1}>
                <Cell truncate={200}>
                  <EntityLink
                    href={`/sales/people/${r.salesmanId}`}
                  >
                    {r.salesmanName}
                  </EntityLink>
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

/**
 * What each sortable column is worth.
 *
 * "Last spoke" is the reason this screen wanted sorting at all — the query
 * orders by it already, and the question underneath it is asked both ways: who
 * has been silent longest, and who is still reporting. A handset that has
 * never spoken has no date and sorts LAST in either direction, which is right
 * here: it is a person who has never signed in on a phone rather than one who
 * has gone quiet, and the metric above the table is where that is said.
 */
const COLUMNS: SortColumns<{
  salesmanName: string;
  lastSeenAt: Date | string | null;
  rejected7d: number;
  conflicted7d: number;
  unresolvedConflicts: number;
}> = {
  name: (r) => r.salesmanName,
  spoke: (r) => (r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : null),
  rejected: (r) => r.rejected7d,
  conflicted: (r) => r.conflicted7d,
  unresolved: (r) => r.unresolvedConflicts,
};
