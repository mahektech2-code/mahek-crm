import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { getConfig } from "@/lib/config/store";
import { fieldReceipts } from "@/lib/services/sales-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import {
  plural,
} from "../words";

export const metadata = { title: "Payments — Sales Dashboard — MahekOne" };

/**
 * What the field says it has collected, and who is still holding cash.
 *
 * Two different questions on one screen, and the design is right to put them
 * together: the second is the one with somebody's name on it.
 *
 * **Cash is a personal liability until it is banked.** A transfer is already in
 * the bank and a cheque is banked by the office, so only cash is counted
 * against the deposit window — `mbos.payments.cashDepositSlaHours`, which the
 * handset shows the salesman too. A deposit is his half of the answer; accounts
 * confirming it against the statement is the other, and only that half counts
 * as money the business has seen.
 */
export default async function Page() {
  const [receipts, config] = await Promise.all([fieldReceipts(), getConfig()]);

  const slaDays = Math.max(1, Math.round(config["mbos.payments.cashDepositSlaHours"] / 24));

  const cash = receipts.filter(
    (r) => r.mode.toLowerCase() === "cash" && !r.depositedAt && r.status !== "rejected",
  );
  const late = cash.filter((r) => r.heldDays > slaDays);
  const reported = receipts.filter((r) => r.status === "reported");
  const confirmed = receipts.filter((r) => r.status === "confirmed");

  const held = cash.reduce((n, r) => n + Number(r.amountPaise), 0);
  const lateHeld = late.reduce((n, r) => n + Number(r.amountPaise), 0);

  /* Who is holding what, because cash is answered for by a person. */
  const byPerson = new Map<string, { name: string; id: string | null; amount: number; oldest: number }>();
  for (const r of cash) {
    const key = r.salesmanId ?? "—";
    const at = byPerson.get(key) ?? {
      name: r.salesmanName ?? "Nobody named",
      id: r.salesmanId,
      amount: 0,
      oldest: 0,
    };
    at.amount += Number(r.amountPaise);
    at.oldest = Math.max(at.oldest, r.heldDays);
    byPerson.set(key, at);
  }

  return (
    <div className="p-6">
      <ScreenHeader
        title="Payments"
        subtitle={`What the team has collected, and who is still holding company cash. ${plural(slaDays, "working day")} is the deposit window, and it is the same number the handset shows them.`}
      />

      {late.length ? (
        <Banner
          tone="danger"
          title={`${money(lateHeld)} is past the deposit window`}
          body={
            <>
              {[...byPerson.values()]
                .filter((p) => p.oldest > slaDays)
                .map((p) => `${p.name} — ${money(p.amount)}, oldest ${plural(p.oldest, "day")}`)
                .join(" · ")}
              . Cash is a personal liability until it is banked, so this is a conversation with a
              person rather than a number on a report.
            </>
          }
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Cash in hand",
            value: money(held),
            sub: cash.length ? `${plural(cash.length, "receipt")}` : "nothing held",
            tone: held ? "warn" : undefined,
          },
          {
            label: "Past the window",
            value: String(late.length),
            tone: late.length ? "danger" : undefined,
          },
          {
            label: "Reported",
            value: String(reported.length),
            sub: "not yet found in the bank",
          },
          { label: "Confirmed", value: String(confirmed.length), tone: "success" },
        ]}
      />

      {byPerson.size ? (
        <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
          <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Cash in hand, by person
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {[...byPerson.values()].map((p) => (
              <span key={p.name} className="block">
                <span className="block text-[13px] text-body">{p.name}</span>
                <span
                  className={
                    "block text-lg font-semibold tabular-nums " +
                    (p.oldest > slaDays ? "text-danger" : "text-ink")
                  }
                >
                  {money(p.amount)}
                </span>
                <span className="block text-[12px] text-muted">
                  oldest {plural(p.oldest, "day")}
                </span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {receipts.length === 0 ? (
        <Empty
          title="Nothing collected"
          body="No receipt has been recorded on a handset. Money a salesman reports is not money the business has seen — it counts against a bill when accounts confirm it against the bank."
        />
      ) : (
        <Table
          minWidth={1180}
          head={
            <>
              <HeadCell width={160}>Salesman</HeadCell>
              <HeadCell width={210}>Customer</HeadCell>
              <HeadCell align="right" width={140}>Amount</HeadCell>
              <HeadCell width={130}>How</HeadCell>
              <HeadCell width={180}>Reference</HeadCell>
              <HeadCell width={130}>On</HeadCell>
              <HeadCell>State</HeadCell>
            </>
          }
        >
          {receipts.map((r, i) => {
            const isCash = r.mode.toLowerCase() === "cash";
            const overdue = isCash && !r.depositedAt && r.heldDays > slaDays;
            return (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell truncate={160}>
                  {r.salesmanId ? (
                    <Link
                      href={`/sales/people/${r.salesmanId}`}
                      className="no-underline hover:underline"
                    >
                      {r.salesmanName}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell truncate={210}>{r.customerName}</Cell>
                <Cell align="right">{money(r.amountPaise)}</Cell>
                <Cell>{r.mode}</Cell>
                <Cell truncate={180} title={r.note ?? undefined}>
                  {r.reference ?? (
                    <span className="text-muted" title="Asked for, never demanded — a salesman repeating what a customer said rarely has the UTR.">
                      none given
                    </span>
                  )}
                </Cell>
                <Cell>{shortDate(r.receivedAt)}</Cell>
                <Cell>
                  <Pill
                    tone={
                      r.status === "confirmed"
                        ? "success"
                        : r.status === "rejected" || r.status === "reversed"
                          ? "danger"
                          : "warn"
                    }
                  >
                    {r.status}
                  </Pill>
                  {r.depositedAt ? (
                    <span className="ml-1.5" title={`Banked ${stamp(r.depositedAt)}`}>
                      <Pill tone="brand">Deposited</Pill>
                    </span>
                  ) : isCash ? (
                    <span
                      className={
                        "ml-1.5 text-[12px] " + (overdue ? "text-danger" : "text-muted")
                      }
                    >
                      held {plural(r.heldDays, "day")}
                    </span>
                  ) : null}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}

      <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
        A receipt is what the salesman says he collected. It counts against a bill only when
        accounts confirm it against the bank — until then nothing here has moved an outstanding
        balance. Deposited means he has told us he paid the cash in, which is his half of the
        answer and not the confirmation.
      </p>
    </div>
  );
}
