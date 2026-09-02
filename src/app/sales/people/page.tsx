import Link from "next/link";
import { stamp } from "@/lib/format";
import { fieldTeam, knownRegions, managers } from "@/lib/services/sales-service";
import { Managers } from "./managers";
import { Cell, Empty, HeadCell, Pill, Row, ScreenHeader, Table } from "../parts";
import { plural } from "../words";

export const metadata = { title: "The team — Sales Dashboard — MahekOne" };

/**
 * Who is in the field.
 *
 * Holding the `field` app IS the definition, because that is what MBOS sign-in
 * checks — so this list and the handsets can never disagree about who is in the
 * field. Reading a role instead would answer a different question and drift the
 * first time somebody covered a territory.
 *
 * A closed account is listed rather than hidden. A leaver's book still has
 * customers in it and somebody has to move them; a person missing from a list
 * reads as a broken list.
 */
export default async function Page() {
  const [team, managerRows, regions] = await Promise.all([
    fieldTeam(),
    managers(),
    knownRegions(),
  ]);

  return (
    <div className="p-6">
      <ScreenHeader
        title="The team"
        subtitle="Everybody who can sign in to a handset. Open somebody to see everything MBOS has recorded for them — visits, orders, money, hours, leave, expenses and what they are working on."
      />

      {team.length === 0 ? (
        <Empty
          title="Nobody holds the Salesman App"
          body="The field team is whoever has been granted the `field` app. Grant it on the Access screen in the Admin Console, or from a terminal with npm run app:grant -- field somebody@mahek.in."
        />
      ) : (
        <Table
          minWidth={980}
          head={
            <>
              <HeadCell width={220}>Name</HeadCell>
              <HeadCell width={190}>Work number</HeadCell>
              <HeadCell align="right" width={110}>Customers</HeadCell>
              <HeadCell width={190}>Handset</HeadCell>
              <HeadCell width={190}>Last signed in</HeadCell>
              <HeadCell />
            </>
          }
        >
          {team.map((t, i) => (
            <Row key={t.id} striped={i % 2 === 1}>
              <Cell truncate={220}>
                <Link
                  href={`/sales/people/${t.id}`}
                  className="font-medium text-ink no-underline"
                >
                  {t.name}
                </Link>
                {t.active ? null : (
                  <span className="ml-2">
                    <Pill>Closed account</Pill>
                  </span>
                )}
              </Cell>
              <Cell>{t.phone ?? <span className="text-muted">Not recorded</span>}</Cell>
              <Cell align="right">
                {t.customerCount ? (
                  plural(t.customerCount, "shop")
                ) : (
                  <span
                    className="text-warn-ink"
                    title="No customers name this person as their sales account manager, so their handset opens on an empty book."
                  >
                    Empty book
                  </span>
                )}
              </Cell>
              <Cell>
                {t.deviceBoundAt ? (
                  <span title={`Bound ${stamp(t.deviceBoundAt)}`}>
                    {t.lastSeenAt ? `Synced ${stamp(t.lastSeenAt)}` : "Bound, never synced"}
                  </span>
                ) : (
                  <span className="text-muted">Never signed in on a phone</span>
                )}
              </Cell>
              <Cell>
                {t.lastLoginAt ? (
                  stamp(t.lastLoginAt)
                ) : (
                  <span className="text-muted">Never</span>
                )}
              </Cell>
              <Cell align="right">
                <Link
                  href={`/sales/journeys?salesman=${t.id}`}
                  className="text-[13px] text-[#5223E0] no-underline"
                >
                  Plan a route
                </Link>
              </Cell>
            </Row>
          ))}
        </Table>
      )}
      <Managers managers={managerRows} regions={regions} />
    </div>
  );
}
