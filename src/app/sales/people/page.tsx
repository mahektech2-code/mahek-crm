import Link from "next/link";
import { stamp } from "@/lib/format";
import { fieldTeam, knownPlaces, knownRegions, managers } from "@/lib/services/sales-service";
import { getCurrentUser, isManager } from "@/lib/auth";
import { Credentials } from "./credentials";
import { Managers } from "./managers";
import { Territories, WorksCell } from "./territories";
import { Banner, Cell, Empty, HeadCell, Pill, Row, ScreenHeader, Table } from "../parts";
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
  const [team, managerRows, regions, places, me] = await Promise.all([
    fieldTeam(),
    managers(),
    knownRegions(),
    knownPlaces(),
    getCurrentUser(),
  ]);

  /* Handing out credentials is guarded by `isManager` in `people.ts`, not by
     holding the Sales Dashboard, and that boundary is deliberate: a sign-in is
     an account decision rather than a sales one. Resolved here so the control
     can be drawn disabled with the reason on it, rather than as a button that
     fails when it is pressed. */
  const canManageAccounts = !!me && isManager(me);

  /* A CLOSED account is left out: its handset is not showing an empty book,
     it is not signing in at all, and naming a leaver in a banner about work
     going undone sends somebody to fix the wrong thing. */
  const unallocated = team.filter((t) => t.active && !(t.territories ?? []).length);

  return (
    <div className="p-6">
      <ScreenHeader
        title="The team"
        subtitle="Everybody who can sign in to a handset. Open somebody to see everything MBOS has recorded for them — visits, orders, money, hours, leave, expenses and what they are working on."
      />

      {/*
        WHOSE HANDSET IS SWITCHED OFF, counted at the top rather than left to be
        noticed a row at a time.

        No area allocated now means no customers at all — a reversal, and the
        whole risk of it is that an empty handset looks exactly like a quiet
        week. The banner is what pays for the reversal: the office sees the
        number the moment it opens this screen, and the salesman sees the reason
        the moment he opens the app. An unallocated salesman with no banner
        anywhere is the failure this feature would otherwise create.
      */}
      {unallocated.length ? (
        <div className="mb-4">
          <Banner
            tone="danger"
            title={`${plural(unallocated.length, "handset")} showing no customers`}
            body={
              <>
                No area is set for {unallocated.map((t) => t.name).join(", ")}, so their
                customer list is empty. Set one with <b>Where they work</b> on their row —
                nothing of theirs is lost in the meantime, and the app tells them why it is
                empty rather than showing a blank screen.
              </>
            }
          />
        </div>
      ) : null}

      {team.length === 0 ? (
        <Empty
          title="Nobody holds the Salesman App"
          body="The field team is whoever has been granted the `field` app. Grant it on the Access screen in the Admin Console, or from a terminal with npm run app:grant -- field somebody@mahek.in."
        />
      ) : (
        <Table
          minWidth={1180}
          head={
            <>
              <HeadCell width={220}>Name</HeadCell>
              <HeadCell width={190}>Work number</HeadCell>
              <HeadCell align="right" width={110}>Customers</HeadCell>
              <HeadCell width={190}>Handset</HeadCell>
              <HeadCell width={190}>Works</HeadCell>
              <HeadCell width={170}>Last signed in</HeadCell>
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
              {/* Where he works NARROWS the book in the column to its left —
                  it never widens it. Both are shown because the pair is the
                  question somebody actually has: how many shops are his, and
                  how many of those are in front of him today. */}
              <Cell truncate={190}>
                <WorksCell salesman={t} />
              </Cell>
              <Cell>
                {t.lastLoginAt ? (
                  stamp(t.lastLoginAt)
                ) : (
                  <span className="text-muted">Never</span>
                )}
              </Cell>
              <Cell align="right">
                <span className="inline-flex items-center gap-2">
                  <Territories salesman={t} places={places} />
                  <Link
                    href={`/sales/journeys?salesman=${t.id}`}
                    className="text-[13px] text-[#5223E0] no-underline"
                  >
                    Plan a route
                  </Link>
                  <Credentials salesman={t} canManageAccounts={canManageAccounts} />
                </span>
              </Cell>
            </Row>
          ))}
        </Table>
      )}
      <Managers managers={managerRows} regions={regions} />
    </div>
  );
}
