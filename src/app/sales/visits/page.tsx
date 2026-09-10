import { getConfig } from "@/lib/config/store";
import { clock, money } from "@/lib/format";
import { today } from "@/lib/recompute";
import {
  travelLegsForDay,
  travelTotalsForDay,
  visitsList,
} from "@/lib/services/sales-service";
import { travelModeLabel } from "@/lib/mbos/travel-labels";
import { Cell, Empty, HeadCell, Pill, Row, Table } from "../parts";
import { VisitsScreen } from "./visits-screen";

export const metadata = { title: "Visits — Sales Dashboard — MahekOne" };

/**
 * Every visit logged on a day.
 *
 * The design's subtitle carries the rule that matters: **an unverified visit
 * still counts as work — it needs a word from you.** The handset saves a visit
 * whatever the checklist says, because refusing teaches people to stop logging
 * them and then the office knows nothing rather than something imperfect. What
 * it records instead is WHY it could not be verified, and that sentence is the
 * column a manager reads.
 *
 * An off-plan visit is treated the same way: it is ordinary — a shop that
 * called, a walk-in on the way past — and it carries the reason the salesman
 * gave rather than a flag implying he went wandering.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; show?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;

  const [all, config, legs, totals] = await Promise.all([
    visitsList(day),
    getConfig(),
    travelLegsForDay(day),
    travelTotalsForDay(day),
  ]);
  const show = ["all", "unverified", "offplan"].includes(params.show ?? "")
    ? params.show!
    : "all";

  return (
    <>
      <VisitsScreen
        day={day}
        longDay={longDay(day)}
        all={all}
        show={show}
        mismatchThresholdM={config["mbos.location.visitMismatchM"]}
      />
      <Travel legs={legs} totals={totals} />
    </>
  );
}

/**
 * HOW THE DAY WAS TRAVELLED, and it is a section of its own rather than more
 * columns on the table above.
 *
 * The table above is built out of VISITS, so it can only ever show journeys
 * that ended in one — and the journeys that did not are precisely the ones
 * worth a manager's minute. A salesman who set off for a shop, arrived, found
 * the shutter down and went home travelled twenty-three kilometres the company
 * owes him for, and on a screen made of visits he did nothing that morning.
 *
 * A leg still running is listed too. That is the ordinary state at any moment
 * in a working day, and hiding it until it closed would make this lag the
 * field by however long the drive takes.
 */
function Travel({
  legs,
  totals,
}: {
  legs: Awaited<ReturnType<typeof travelLegsForDay>>;
  totals: Awaited<ReturnType<typeof travelTotalsForDay>>;
}) {
  /* Only the ones the table above cannot account for. Repeating every leg that
     already has a row up there would double the length of the screen to say
     nothing new — and the point of this section is the residue. */
  const loose = legs.filter((l) => !l.visitId);

  return (
    <section className="mt-8">
      <h2 className="text-[15px] font-medium text-ink">Travel</h2>
      <p className="mt-1 max-w-[70ch] text-[13px] text-muted">
        Distance is what the odometer said at both ends of a journey on
        somebody&rsquo;s own vehicle, and a fare is what they handed over. The two
        are never added together — one is a distance and the other is money.
      </p>

      {totals.length === 0 ? (
        <div className="mt-3">
          <Empty
            title="Nothing travelled"
            body="No journeys have come off a handset for this day. A journey opens when a salesman presses Start visit and reaches the office on the next sync."
          />
        </div>
      ) : (
        <div className="mt-3">
          <Table
            minWidth={900}
            head={
              <>
                <HeadCell width={220}>Salesman</HeadCell>
                <HeadCell align="right" width={110}>Journeys</HeadCell>
                <HeadCell align="right" width={150}>Own vehicle</HeadCell>
                <HeadCell align="right" width={150}>Tickets</HeadCell>
                <HeadCell>Not accounted for</HeadCell>
              </>
            }
          >
            {totals.map((t, i) => (
              <Row key={t.salesmanId} striped={i % 2 === 1}>
                <Cell truncate={220}>{t.salesmanName}</Cell>
                <Cell align="right">{t.legs}</Cell>
                <Cell align="right">
                  {t.ownVehicleKm ? (
                    `${t.ownVehicleKm.toLocaleString("en-IN")} km`
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell align="right">
                  {Number(t.ticketPaise) ? (
                    money(t.ticketPaise)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                {/* THE HOLE IN THE TOTAL, said out loud. A metered journey with
                    no distance means the arrival never closed — he is still
                    out, or the second reading has not synced — and a total that
                    quietly skipped those would fall as the day went on and rise
                    again at night, which reads as a bug rather than a queue. */}
                <Cell>
                  {t.unmeasured || t.abandoned ? (
                    <span className="text-[12px]">
                      {t.unmeasured ? (
                        <Pill tone="warn">
                          {t.unmeasured} not measured yet
                        </Pill>
                      ) : null}
                      {t.abandoned ? (
                        <span className={t.unmeasured ? "ml-1.5" : undefined}>
                          <Pill>{t.abandoned} called off</Pill>
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted">Every journey measured</span>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        </div>
      )}

      {loose.length ? (
        <div className="mt-6">
          <h3 className="text-[13px] font-medium text-ink">
            Journeys with no visit behind them
          </h3>
          <p className="mt-1 max-w-[70ch] text-[13px] text-muted">
            Somebody set off and the visit never came — still on the road, the
            shop was shut, or the trip was called off. The kilometres happened
            either way.
          </p>
          <div className="mt-3">
            <Table
              minWidth={980}
              head={
                <>
                  <HeadCell width={180}>Salesman</HeadCell>
                  <HeadCell width={220}>Going to</HeadCell>
                  <HeadCell width={90}>Set off</HeadCell>
                  <HeadCell width={140}>How</HeadCell>
                  <HeadCell align="right" width={110}>Distance</HeadCell>
                  <HeadCell>What happened</HeadCell>
                </>
              }
            >
              {loose.map((l, i) => (
                <Row key={l.id} striped={i % 2 === 1}>
                  <Cell truncate={180}>{l.salesmanName}</Cell>
                  <Cell truncate={220}>{l.customerName}</Cell>
                  <Cell>
                    {/* `db.execute` hands raw SQL back with its timestamps as
                        STRINGS however the type reads, so the coercion is
                        deliberate rather than defensive — `clock` calls
                        `getTime()` and a string would throw the whole screen. */}
                    {l.departedAt ? (
                      clock(new Date(l.departedAt))
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Cell>
                  <Cell>{travelModeLabel(l.mode)}</Cell>
                  <Cell align="right">
                    {l.distanceKm != null ? (
                      `${l.distanceKm.toLocaleString("en-IN")} km`
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Cell>
                  <Cell truncate={340}>
                    {l.abandonedAt ? (
                      <>
                        <Pill tone="warn">Called off</Pill>
                        {l.abandonReason ? (
                          <span className="block truncate text-[12px] text-muted">
                            {l.abandonReason}
                          </span>
                        ) : null}
                      </>
                    ) : l.arrivedAt ? (
                      <>
                        <Pill>Arrived, no visit</Pill>
                        <span className="block text-[12px] text-muted">
                          He got there and logged nothing — worth asking why.
                        </span>
                      </>
                    ) : (
                      <>
                        <Pill>On the road</Pill>
                        <span className="block text-[12px] text-muted">
                          Still travelling, or the arrival has not synced yet.
                        </span>
                      </>
                    )}
                    {/* The evidence, where there is any. A distance nobody can
                        check is a number a salesman typed about his own
                        reimbursement. */}
                    {l.startPhotoId || l.endPhotoId || l.ticketPhotoId ? (
                      <span className="mt-0.5 flex gap-2.5 text-[12px]">
                        {l.startPhotoId ? (
                          <a
                            href={`/api/attachments/${l.startPhotoId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand no-underline"
                          >
                            Meter at the start
                          </a>
                        ) : null}
                        {l.endPhotoId ? (
                          <a
                            href={`/api/attachments/${l.endPhotoId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand no-underline"
                          >
                            Meter at the end
                          </a>
                        ) : null}
                        {l.ticketPhotoId ? (
                          <a
                            href={`/api/attachments/${l.ticketPhotoId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand no-underline"
                          >
                            Ticket
                          </a>
                        ) : null}
                      </span>
                    ) : null}
                  </Cell>
                </Row>
              ))}
            </Table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
