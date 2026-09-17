import { stamp } from "@/lib/format";
import { deviceBindings } from "@/lib/services/sales-service";
import { ReleaseButton } from "./release-button";
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

export const metadata = { title: "Login history — Sales Dashboard — MahekOne" };

/**
 * Which handset each salesman signed in on.
 *
 * The design shows a login LOG — every attempt, the device, where from, and
 * what failed. **MahekOne records none of that.** There is no failed-attempt
 * table, no location on a sign-in and no device string on a session; the Admin
 * Console deleted its own version of this screen rather than render a fixture,
 * and the same reasoning applies here.
 *
 * What does exist is the device binding, and it answers most of what the
 * screen was for: one handset per person, when it was bound, when it last
 * spoke to MahekOne, and whether an admin has released it. The gap is named on
 * the screen rather than filled in.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const rows = await deviceBindings();

  const bound = rows.filter((r) => r.deviceId && r.deviceActive);
  const never = rows.filter((r) => !r.deviceId);
  const released = rows.filter((r) => r.releasedAt);

  /* Sorting is DISPLAY ONLY: the three figures above the table are counted
     over every row, and a "never signed in" count that changed when somebody
     re-ordered a column would be the screen contradicting itself. What sorting
     moves is which row is at the top, which is the whole of what a manager
     scanning for old builds or dead handsets is asking for. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/logins", sort, key)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Handsets and sign-in"
        subtitle="One device per person, unless that is switched off in App preferences. A second handset is refused until somebody releases the first — that is not a fault, it is what stops one salesman's visits being logged from somebody else's phone."
      />

      <Banner
        tone="info"
        title="This is not a login log"
        body="The design lists every sign-in attempt with its device, its location and the reason it failed. MahekOne stores none of those — no failed-attempt table, no location on a session — so what is shown is the device binding and the last time each handset spoke. Nothing here is inferred."
      />

      <MetricRow
        metrics={[
          { label: "Handsets bound", value: `${bound.length} of ${rows.length}` },
          {
            label: "Never signed in",
            value: String(never.length),
            tone: never.length ? "warn" : undefined,
          },
          { label: "Released", value: String(released.length), sub: "by an admin" },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nobody holds the Salesman App"
          body="The field team is whoever has been granted it."
        />
      ) : (
        <Table
          minWidth={1260}
          head={
            <>
              {head("name", "Salesman", 200)}
              {/* The model and the device id underneath it have no order worth
                  asking for — an id is a random string, and the model is
                  whatever the phone calls itself. The state column is a set of
                  pills and the last is the release control; neither is a
                  value. */}
              <HeadCell width={220}>Handset</HeadCell>
              {head("version", "App", 130)}
              {head("bound", "Bound", 190)}
              {head("spoke", "Last spoke", 190)}
              <HeadCell width={210}>State</HeadCell>
              <HeadCell>Handset</HeadCell>
            </>
          }
        >
          {sorted.map((r, i) => (
            <Row key={`${r.salesmanId}:${r.deviceId ?? "none"}`} striped={i % 2 === 1}>
              <Cell truncate={200}>
                <EntityLink
                  href={`/sales/people/${r.salesmanId}`}
                >
                  {r.salesmanName}
                </EntityLink>
              </Cell>
              <Cell truncate={220} title={r.deviceId ?? undefined}>
                {r.model ?? r.platform ?? (
                  <span className="text-muted">Never signed in on a phone</span>
                )}
                {r.deviceId ? (
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {r.deviceId.slice(0, 18)}…
                  </span>
                ) : null}
              </Cell>
              <Cell>{r.appVersion ?? <span className="text-muted">—</span>}</Cell>
              <Cell>{r.boundAt ? stamp(r.boundAt) : <span className="text-muted">—</span>}</Cell>
              <Cell>
                {r.lastSeenAt ? (
                  stamp(r.lastSeenAt)
                ) : r.deviceId ? (
                  <span className="text-warn-ink">Bound, never synced</span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
              <Cell truncate={210} title={r.releaseReason ?? undefined}>
                {!r.deviceId ? (
                  <Pill tone="warn">No handset</Pill>
                ) : r.releasedAt ? (
                  <>
                    <Pill>Released</Pill>
                    {r.releaseReason ? (
                      <span className="block truncate text-[12px] text-muted">
                        {r.releaseReason}
                      </span>
                    ) : null}
                  </>
                ) : r.deviceActive ? (
                  <Pill tone="success">Active</Pill>
                ) : (
                  <Pill>Inactive</Pill>
                )}
              </Cell>
              {/* Only a live binding can be released. A row that has already
                  been released, or a salesman who has never signed in on a
                  phone, has nothing to act on — and a disabled button on
                  every second row is furniture rather than an offer. */}
              <Cell>
                {r.deviceId && r.deviceActive && !r.releasedAt ? (
                  <ReleaseButton
                    deviceId={r.deviceId}
                    salesmanName={r.salesmanName}
                    handset={r.model ?? r.platform ?? "the handset he is signed in on"}
                  />
                ) : (
                  <span className="text-[12px] text-muted">—</span>
                )}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

/**
 * What each sortable column is worth.
 *
 * The APP version is here because it is the one question this screen can
 * answer that nothing else can: an APK cannot be recalled, so "who is still on
 * an old build" is asked every time something ships, and it was unanswerable
 * on a list ordered by when a phone last spoke. It is compared as a string
 * with `localeCompare`'s numeric option, which reads 1.5.0 above 1.10.0 —
 * wrong in the strict semantic-version sense and right for the only comparison
 * anybody makes here, which is against the one version currently published.
 *
 * A salesman who has never signed in on a phone has no bound date, no last
 * contact and no version, and sorts LAST in either direction rather than
 * heading "oldest build" — the metric above the table is where his absence is
 * counted.
 */
const COLUMNS: SortColumns<{
  salesmanName: string;
  appVersion: string | null;
  boundAt: Date | string | null;
  lastSeenAt: Date | string | null;
}> = {
  name: (r) => r.salesmanName,
  version: (r) => r.appVersion,
  bound: (r) => (r.boundAt ? new Date(r.boundAt).getTime() : null),
  spoke: (r) => (r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : null),
};
