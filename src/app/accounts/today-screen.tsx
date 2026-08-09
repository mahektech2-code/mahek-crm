"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { money, stamp } from "@/lib/format";
import type { AccountsHome } from "@/lib/services/accounts-home-service";
import { AccountsIcon } from "./icons";
import { AgingStrip, Banner, Pill, plural, waitingWords } from "./parts";

/* ---------------------------------------------------------------------------
 * Today.
 *
 * The app used to open onto the approvals queue, which answers "what is the
 * oldest order" and nothing else. This answers the question somebody actually
 * arrives with: what is waiting on this desk, is any of it going stale, how
 * much money came in, and what have I already decided.
 * ------------------------------------------------------------------------- */

export function TodayScreen({
  home,
  userName,
  canDecide,
  greeting,
  todayLabel,
}: {
  home: AccountsHome;
  userName: string;
  canDecide: boolean;
  /**
   * Both of these are read from the clock on the SERVER and passed down. The
   * React Compiler rules here forbid reading it during render, and a greeting
   * that says "good morning" because the tab was left open overnight is the
   * reason the rule exists.
   */
  greeting: string;
  todayLabel: string;
}) {
  const router = useRouter();
  const waiting = home.orders.count + home.payments.count + home.credits.count;
  const stale = home.payments.stale;

  const cards = [
    {
      href: "/accounts/approvals",
      label: "Orders waiting",
      value: String(home.orders.count),
      sub: `${money(home.orders.value)} held, none of it billed`,
      oldest: home.orders.count
        ? `Oldest ${waitingWords(home.orders.oldestHours)}`
        : "Nothing waiting",
      flag: home.orders.stale
        ? `${home.orders.stale} past ${home.staleHours}h`
        : "",
      tone: "danger" as const,
    },
    {
      href: "/accounts/payments",
      label: "Payments to confirm",
      value: String(home.payments.count),
      sub: `${money(home.payments.value)} claimed, none of it in the ledger`,
      oldest: home.payments.count
        ? `Oldest ${waitingWords(home.payments.oldestHours)}`
        : "Nothing waiting",
      flag: stale ? `${stale} past ${home.staleHours}h` : "",
      tone: "danger" as const,
    },
    {
      href: "/accounts/credits",
      label: "Credit notes",
      value: String(home.credits.count),
      sub: `${money(home.credits.value)} asked for against complaints`,
      oldest: home.credits.count
        ? `Oldest ${waitingWords(home.credits.oldestHours)}`
        : "Nothing waiting",
      flag: "",
      tone: "warn" as const,
    },
  ];

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <div className="mb-5">
          <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
            {greeting}, {userName.split(" ")[0]}
          </h1>
          <p className="mt-1 text-[13px] leading-[18px] text-muted">
            {todayLabel} ·{" "}
            {waiting
              ? `${plural(waiting, "decision")} waiting on this desk`
              : "nothing waiting on this desk"}
          </p>
        </div>

        {stale ? (
          <Banner
            tone="danger"
            action={
              <button
                onClick={() => router.push("/accounts/payments")}
                className="h-7.5 cursor-pointer rounded-[4px] border border-danger bg-danger px-3 text-[13px] font-medium text-white hover:opacity-90"
              >
                Work the queue
              </button>
            }
          >
            <span className="flex items-center gap-3">
              <AccountsIcon name="clock" size={16} stroke="#B3261E" className="flex-none" />
              <span>
                {plural(stale, "payment")} {stale === 1 ? "has" : "have"} been waiting more
                than {plural(home.staleHours, "hour")}. A customer is left alone for{" "}
                {plural(home.quietDays, "day")} on the strength of a reported payment —
                after that they are chased again, whether or not this was ever decided.
              </span>
            </span>
          </Banner>
        ) : null}

        {!canDecide ? (
          <Banner tone="warn" title="You can read this desk but not decide on it">
            Approving orders, confirming money and issuing credit notes are the accounts
            team&apos;s. Everything here is visible to you and none of it is actionable.
          </Banner>
        ) : null}

        <div className="mb-4 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
          {cards.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="block rounded-[6px] border border-line bg-surface px-5 py-4 no-underline transition-colors duration-100 hover:border-brand hover:no-underline"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  {c.label}
                </span>
                {c.flag ? <Pill tone={c.tone}>{c.flag}</Pill> : null}
              </span>
              <span className="mt-1.5 block text-[28px] leading-[34px] font-semibold tabular-nums text-ink">
                {c.value}
              </span>
              <span className="mt-0.5 block text-[13px] text-muted">{c.sub}</span>
              <span className="mt-3.5 flex items-center justify-between border-t border-divider pt-3">
                <span className="min-w-0 truncate text-[13px] text-muted">{c.oldest}</span>
                <span className="flex-none text-[13px] font-medium whitespace-nowrap text-brand">
                  Open →
                </span>
              </span>
            </Link>
          ))}
        </div>

        <div className="grid items-start gap-4 [grid-template-columns:minmax(0,1fr)_clamp(300px,28%,400px)]">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="rounded-[6px] border border-line bg-surface">
              <div className="flex items-baseline justify-between gap-3 border-b border-divider px-5 py-3.5">
                <h2 className="text-lg leading-6 font-semibold text-ink">Money in</h2>
                <span className="text-[13px] text-muted">
                  Confirmed only — reported money is not counted here
                </span>
              </div>
              <div className="flex flex-wrap gap-x-8 gap-y-3.5 px-5 py-4">
                <Figure
                  label="Today"
                  value={money(home.money.confirmedToday)}
                  sub={`${plural(home.money.confirmedTodayCount, "receipt")} confirmed`}
                  tone={home.money.confirmedToday > 0 ? "success" : undefined}
                />
                <Figure
                  label="This month"
                  value={money(home.money.confirmedThisMonth)}
                  sub={`${plural(home.money.confirmedThisMonthCount, "receipt")} confirmed`}
                  tone={home.money.confirmedThisMonth > 0 ? "success" : undefined}
                />
                <Figure
                  label="Awaiting confirmation"
                  value={money(home.money.awaiting)}
                  sub="not in any figure above"
                  tone={home.money.awaiting > 0 ? "warn" : undefined}
                />
                <Figure
                  label="On account"
                  value={money(home.money.onAccount)}
                  sub="received, not yet against a bill"
                />
              </div>
            </section>

            <section className="rounded-[6px] border border-line bg-surface">
              <div className="flex items-baseline justify-between gap-3 border-b border-divider px-5 py-3.5">
                <h2 className="text-lg leading-6 font-semibold text-ink">
                  The book, by age
                </h2>
                <span className="text-[13px] text-muted">
                  {money(home.aging.total)} open across {plural(home.aging.bills, "bill")}
                </span>
              </div>
              <div className="px-5 py-4">
                <AgingStrip buckets={home.aging.buckets} />
              </div>
            </section>
          </div>

          <section className="min-w-0 rounded-[6px] border border-line bg-surface">
            <div className="flex items-baseline justify-between gap-3 border-b border-divider px-5 py-3.5">
              <h2 className="text-lg leading-6 font-semibold text-ink">Decided today</h2>
              <Link
                href="/accounts/audit"
                className="flex-none text-[13px] font-medium text-brand no-underline hover:underline"
              >
                Full log
              </Link>
            </div>
            {home.decided.length ? (
              home.decided.map((d, i) => (
                <div
                  key={`${d.at.toISOString()}-${i}`}
                  className="flex items-start gap-3 border-t border-canvas px-5 py-3 first:border-t-0"
                >
                  <span
                    className={cx(
                      "mt-[7px] block h-1.5 w-1.5 flex-none rounded-full",
                      d.action.endsWith("reject") ||
                        d.action.endsWith("refuse") ||
                        d.action.endsWith("decline")
                        ? "bg-danger"
                        : "bg-success",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-pretty text-ink">
                      {d.line}
                      {d.customerName ? ` · ${d.customerName}` : ""}
                    </span>
                    <span className="mt-px block text-xs text-muted">
                      By {d.actorName ?? "somebody"}, {stamp(d.at)}
                    </span>
                  </span>
                </div>
              ))
            ) : (
              <p className="px-5 py-8 text-center text-sm text-pretty text-muted">
                Nothing decided yet today. Anything you approve, decline, confirm or
                reject shows here with a way back to it.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "success" | "warn";
}) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        {label}
      </span>
      <span
        className={cx(
          "block text-[22px] leading-7 font-semibold whitespace-nowrap tabular-nums",
          tone === "success" ? "text-success" : tone === "warn" ? "text-warn-ink" : "text-ink",
        )}
      >
        {value}
      </span>
      <span className="block text-xs whitespace-nowrap text-muted">{sub}</span>
    </span>
  );
}

