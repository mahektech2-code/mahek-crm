import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { leadsList } from "@/lib/services/sales-service";
import {
  Cell,
  Empty,
  HeadCell,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import {
  plural,
} from "../words";

export const metadata = { title: "Leads — Sales Dashboard — MahekOne" };

/** The qualification ladder, in the order it is climbed. */
const STAGES = ["new", "contacted", "qualified", "negotiation", "won", "lost"] as const;

/**
 * Shops that are not on the book yet.
 *
 * The funnel across the top is the design's, and it is counted rather than
 * estimated: each band is how many leads are sitting at that stage and what
 * they are worth if they all came in. That second number is a POTENTIAL, typed
 * by whoever raised the lead, and the screen says so — an estimate presented
 * beside real order values gets read as one.
 *
 * Stale is a measured thing, not a mood: `mbos.leads.staleDays` from
 * configuration, counted from the last activity date. Nothing here archives a
 * lead — a shop that said no in March is exactly who somebody wants to find in
 * September, and the nightly sweep only ever files them out of the way.
 */
export default async function Page() {
  const day = await today();
  const [leads, config] = await Promise.all([leadsList(day), getConfig()]);

  const staleDays = config["mbos.leads.staleDays"];
  const working = leads.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const stale = working.filter((l) => l.quietDays >= staleDays);

  const funnel = STAGES.map((stage) => {
    const at = leads.filter((l) => l.stage === stage);
    return {
      stage,
      count: at.length,
      potential: at.reduce((n, l) => n + Number(l.estimatedPotentialPaise ?? 0), 0),
    };
  });
  const widest = Math.max(1, ...funnel.map((f) => f.count));

  return (
    <div className="p-6">
      <ScreenHeader
        title="Leads"
        subtitle={`Prospects each salesman is working. Anything untouched for ${plural(staleDays, "day")} is tagged stale — that threshold is configuration, not a rule this screen invented.`}
      />

      {leads.length === 0 ? (
        <Empty
          title="No leads"
          body="A lead is a shop that is not on the book yet. They are raised on the handset, and the duplicate check reads customers as well as leads — the number somebody is about to type is quite often already an account."
        />
      ) : (
        <>
          <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
            <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              The funnel
            </div>
            <div className="space-y-2">
              {funnel.map((f) => (
                <div key={f.stage} className="flex items-center gap-3">
                  <span className="w-[110px] flex-none text-[13px] text-body capitalize">
                    {f.stage}
                  </span>
                  <span className="w-10 flex-none text-right text-sm font-semibold text-ink tabular-nums">
                    {f.count}
                  </span>
                  <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-canvas">
                    <span
                      className={
                        "block h-full rounded-[4px] " +
                        (f.stage === "won"
                          ? "bg-success"
                          : f.stage === "lost"
                            ? "bg-line-strong"
                            : "bg-brand")
                      }
                      style={{ width: `${Math.round((f.count / widest) * 100)}%` }}
                    />
                  </span>
                  <span className="w-[190px] flex-none text-right text-[12px] text-muted">
                    {f.potential ? `${money(f.potential)} potential` : "no value estimated"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-muted">
              Potential is what the salesman estimated when he raised the lead. It is not an order
              value and nothing derives from it.
            </p>
          </section>

          {stale.length ? (
            <div className="mb-4 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-4 py-3">
              <div className="text-sm font-semibold text-ink">
                {plural(stale.length, "lead")} nobody has touched in {plural(staleDays, "day")}
              </div>
              <div className="mt-0.5 text-[13px] text-body">
                {stale
                  .slice(0, 4)
                  .map((l) => `${l.name} (${l.quietDays}d)`)
                  .join(" · ")}
                {stale.length > 4 ? ` and ${stale.length - 4} more` : ""}
              </div>
            </div>
          ) : null}

          <Table
            minWidth={1140}
            head={
              <>
                <HeadCell width={240}>Lead</HeadCell>
                <HeadCell width={170}>Owner</HeadCell>
                <HeadCell width={140}>Source</HeadCell>
                <HeadCell align="right" width={150}>Potential</HeadCell>
                <HeadCell width={140}>Stage</HeadCell>
                <HeadCell width={150}>Next</HeadCell>
                <HeadCell width={150}>Last worked</HeadCell>
              </>
            }
          >
            {leads.map((l, i) => (
              <Row key={l.id} striped={i % 2 === 1}>
                <Cell truncate={240}>
                  <span className="font-medium text-ink">{l.name}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {[l.companyName, l.city].filter(Boolean).join(" · ") || l.mobile || "—"}
                  </span>
                </Cell>
                <Cell truncate={170}>
                  {l.salesmanId ? (
                    <Link
                      href={`/sales/people/${l.salesmanId}`}
                      className="no-underline hover:underline"
                    >
                      {l.salesmanName}
                    </Link>
                  ) : (
                    <span className="text-warn-ink" title="Nobody is working this lead.">
                      Nobody
                    </span>
                  )}
                </Cell>
                <Cell className="capitalize">{l.source.replace(/_/g, " ")}</Cell>
                <Cell align="right">
                  {l.estimatedPotentialPaise ? (
                    money(l.estimatedPotentialPaise)
                  ) : (
                    <span className="text-muted">Not estimated</span>
                  )}
                </Cell>
                <Cell>
                  <Pill
                    tone={
                      l.stage === "won" ? "success" : l.stage === "lost" ? "danger" : "brand"
                    }
                  >
                    {l.stage}
                  </Pill>
                </Cell>
                <Cell>
                  {l.nextFollowUpDate ? (
                    shortDate(l.nextFollowUpDate)
                  ) : (
                    <span className="text-muted">None promised</span>
                  )}
                </Cell>
                <Cell>
                  {l.lastActivityDate ? shortDate(l.lastActivityDate) : "—"}
                  {l.quietDays >= staleDays && l.stage !== "won" && l.stage !== "lost" ? (
                    <span className="block text-[12px] text-warn-ink">
                      quiet {plural(l.quietDays, "day")}
                    </span>
                  ) : null}
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}
