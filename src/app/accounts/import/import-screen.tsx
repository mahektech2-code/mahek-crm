"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { runBillImportAction } from "@/lib/actions/accounts";
import { stamp } from "@/lib/format";
import type { ImportState } from "@/lib/services/bill-import-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  Pill,
  Row,
  ScreenHeader,
  Table,
  plural,
} from "../parts";

/* ---------------------------------------------------------------------------
 * The sheet import.
 *
 * On a deployment nobody has shell access to, a terminal is not a fallback —
 * it is the only door and it is locked. Sales Bills stayed empty through three
 * releases that each claimed to fix it, because the import ran on somebody's
 * laptop against the production database or it did not run at all.
 *
 * The owner cannot be defaulted. The sheet's only ownership column names a
 * sales channel rather than a person, so a customer the projection creates
 * needs somebody's book to land in, and guessing it — whoever pressed the
 * button, say — would quietly assign a thousand customers.
 * ------------------------------------------------------------------------- */

export function ImportScreen({ state }: { state: ImportState }) {
  const router = useRouter();
  const { run } = useToast();
  const [owner, setOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const last = state.last;
  const blocked = !state.canRun
    ? "Running the import is the accounts team’s or a manager’s"
    : !owner
      ? "Choose whose book new customers land in"
      : busy
        ? "Running…"
        : undefined;

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title="Sheet import"
          subtitle="Bills are projected from the Google Sheet by a job. This is what it did, and how to run it without a terminal."
          actions={
            <>
              <select
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                disabled={!state.canRun}
                aria-label="Whose book new customers land in"
                className="h-9 rounded-[4px] border border-line bg-surface px-2.5 text-sm focus:border-brand focus:outline-none disabled:text-muted"
              >
                <option value="">Whose book?</option>
                {state.owners.map((o) => (
                  <option key={o.id} value={o.email}>
                    {o.name}
                  </option>
                ))}
              </select>
              <button
                disabled={Boolean(blocked)}
                title={blocked}
                onClick={async () => {
                  setBusy(true);
                  const r = await run(runBillImportAction(owner));
                  setBusy(false);
                  if (r.ok) router.refresh();
                }}
                className={cx(
                  "h-9 rounded-[4px] border px-4 text-sm font-medium",
                  blocked
                    ? "cursor-not-allowed border-divider bg-divider text-line-strong"
                    : "cursor-pointer border-brand bg-brand text-white hover:bg-brand-hover",
                )}
              >
                {busy ? "Running…" : "Run it now"}
              </button>
            </>
          }
        />

        {!state.canRun ? (
          <Banner tone="warn" title="You can read this but not run it">
            Running the import writes customers, orders and bills. It is the accounts
            team’s and a manager’s.
          </Banner>
        ) : null}

        {last ? (
          <div
            className={cx(
              "mb-4 rounded-[4px] border border-l-[3px] px-4 py-3.5",
              last.ok
                ? "border-line border-l-success bg-surface"
                : "border-danger-soft border-l-danger bg-danger-soft",
            )}
          >
            <div className="text-sm font-medium text-ink">
              {last.ok
                ? `Last run finished ${stamp(last.finishedAt ?? last.startedAt)}`
                : `Last run failed at ${stamp(last.startedAt)}`}
            </div>
            <div className="mt-0.5 text-sm text-pretty text-body">
              {last.ok
                ? `${last.what} · ${plural(last.created, "row")} created, ${last.updated} updated, ${last.unchanged} unchanged, ${plural(last.withIssues, "row")} needing attention.`
                : (last.error ??
                  "The sheet could not be read. Nothing was created or changed, so the bills are exactly as they were before it ran.")}
            </div>
          </div>
        ) : (
          <Banner tone="neutral" title="It has never been run from here">
            Nothing in the log yet. Running it reads the Order Details tab, then turns
            what has landed into customers, orders and bills.
          </Banner>
        )}

        {last?.ok && last.withIssues > 0 ? (
          <Banner tone="warn">
            {plural(last.withIssues, "row")} could not be used — a bill number that could
            not be made unique, or a row the parser could not read. They were left alone
            rather than guessed at, and they are listed in the Admin Console.
          </Banner>
        ) : null}

        <section className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <div className="border-b border-divider px-5 py-3.5 text-lg font-semibold text-ink">
            Recent runs
          </div>
          {state.runs.length === 0 ? (
            <Empty
              title="No runs recorded"
              body="Every run — from here, from a schedule or from a terminal — writes a row. There are none yet."
            />
          ) : (
            <Table
              minWidth={860}
              head={
                <>
                  <HeadCell>Run</HeadCell>
                  <HeadCell>What</HeadCell>
                  <HeadCell align="right">Created</HeadCell>
                  <HeadCell align="right">Updated</HeadCell>
                  <HeadCell align="right">Unchanged</HeadCell>
                  <HeadCell align="right">Needing attention</HeadCell>
                  <HeadCell>By</HeadCell>
                  <HeadCell>Outcome</HeadCell>
                </>
              }
            >
              {state.runs.map((r, i) => (
                <Row key={r.id} striped={i % 2 === 1}>
                  <Cell>{stamp(r.startedAt)}</Cell>
                  <Cell>{r.what}</Cell>
                  <Cell align="right">{r.created.toLocaleString("en-IN")}</Cell>
                  <Cell align="right">{r.updated.toLocaleString("en-IN")}</Cell>
                  <Cell align="right" className="text-muted">
                    {r.unchanged.toLocaleString("en-IN")}
                  </Cell>
                  <Cell
                    align="right"
                    className={r.withIssues ? "text-warn-ink" : "text-muted"}
                  >
                    {r.withIssues || "—"}
                  </Cell>
                  <Cell className="text-muted">{r.triggeredByName ?? "a schedule"}</Cell>
                  <Cell>
                    <Pill tone={r.ok ? "success" : "danger"}>
                      {r.ok ? "Finished" : "Failed"}
                    </Pill>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </section>
      </div>
    </div>
  );
}
