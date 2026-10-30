"use client";

/* ---------------------------------------------------------------------------
 * SHOPS ON TWO LISTS — the ones the one-list rule found already there.
 *
 * The rule refuses a new double; it does not undo the ones made before it.
 * Each shop here is priced today by whichever list is narrowest (the
 * suggestion), and settling it leaves the shop out of every other list — its
 * prices do not move. Picking another list moves it there instead.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { settleAllToTodaysList, settleDoubleListed, shopsOnTwoLists } from "@/lib/actions/price-one-list";
import type { DoubleListedView } from "@/lib/services/price-one-list-service";

export function DoubleListedCard({ basePath, canManage }: { basePath: string; canManage: boolean }) {
  const router = useRouter();
  const { run } = useToast();
  const [rows, setRows] = React.useState<DoubleListedView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [picks, setPicks] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    void shopsOnTwoLists().then((r) => {
      if (!live) return;
      if (r.ok) {
        setRows(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [round]);

  async function settle(all: boolean) {
    if (!rows) return;
    setBusy(true);
    try {
      const r = all
        ? await run(settleAllToTodaysList())
        : await run(
            settleDoubleListed(
              rows
                .map((s) => ({ customerId: s.customerId, keepBookId: picks[s.customerId] ?? "" }))
                .filter((a) => a.keepBookId),
            ),
          );
      if (r.ok) {
        setPicks({});
        setRound((n) => n + 1);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (error) return null;
  if (rows && !rows.length) return null;
  const picked = Object.values(picks).filter(Boolean).length;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={rows ? `On two lists — ${rows.length.toLocaleString("en-IN")} shop${rows.length === 1 ? "" : "s"}` : "On two lists"}
        hint="A shop can be on one price list. These were put on two before the rule existed; settling keeps each on the list that prices it today, so no price changes."
        action={
          canManage && rows?.length ? (
            <div className="flex gap-2">
              {picked ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void settle(false)}>
                  Settle {picked} as picked
                </Button>
              ) : null}
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void settle(true)}>
                Keep all on today&apos;s list
              </Button>
            </div>
          ) : null
        }
      />
      {rows === null ? (
        <p className="px-5 py-4 text-[13px] text-muted">Checking every shop…</p>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full table-fixed">
            <colgroup>
              <col style={{ width: 260 }} />
              <col />
              <col style={{ width: 260 }} />
            </colgroup>
            <thead>
              <tr>
                <Th>Shop</Th>
                <Th>On</Th>
                <Th>Keep it on</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map((s) => (
                <Tr key={s.customerId}>
                  <Td className="truncate" title={s.name}>
                    <Link href={`${basePath}/shops/${s.customerId}`} className="text-ink hover:text-brand">
                      {s.name}
                    </Link>
                    {s.city ? <span className="text-muted"> · {s.city}</span> : null}
                  </Td>
                  <Td className="truncate" title={s.books.map((b) => b.listName).join(", ")}>
                    {s.books.map((b) => b.listName).join(", ")}
                  </Td>
                  <Td>
                    {canManage ? (
                      <Select
                        value={picks[s.customerId] ?? ""}
                        onChange={(e) => setPicks((p) => ({ ...p, [s.customerId]: e.target.value }))}
                        className="w-full"
                      >
                        <option value="">{s.pricedFromName ? `Today: ${s.pricedFromName}` : "Choose…"}</option>
                        {s.books.map((b) => (
                          <option key={b.bookId} value={b.bookId}>
                            {b.listName}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-[13px] text-muted">{s.pricedFromName ?? "—"}</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
          {rows.length > 300 ? (
            <p className="px-5 py-2 text-[12px] text-muted">The first 300 are shown. &ldquo;Keep all on today&apos;s list&rdquo; settles every one.</p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
