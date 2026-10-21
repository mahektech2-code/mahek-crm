"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import type { HistoryFilter, UploadRow } from "@/lib/services/bank-statement-service";
import { Acc, Note, Pill, Ret, retention, Sel, dayLabel, istDay, timeLabel } from "../bank-statements/bank-ui";

/* ---------------------------------------------------------------------------
 * ACCOUNTS → BANK STATEMENT MANAGEMENT → UPLOAD HISTORY.
 *
 * Every upload, for good: who uploaded what, what it brought in, and how long
 * its PDF is kept. Once the PDF is deleted the row says so, and the lines it
 * brought in are one click away on Reconcile.
 * ------------------------------------------------------------------------- */

export function HistoryScreen({
  view,
  filter,
  today,
  accounts,
  retentionDays,
}: {
  view: { rows: UploadRow[]; sum: { n: number; brought: number; skipped: number; kept: number; bytes: number; pages: number }; people: { id: string; name: string }[] };
  filter: HistoryFilter;
  today: string;
  accounts: { id: string; name: string }[];
  retentionDays: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = React.useState(filter.q ?? "");
  const go = (set: Partial<Record<keyof HistoryFilter, string | null>>) => {
    const cur: Record<string, string | null> = { account: filter.account, period: filter.period === "month" ? null : filter.period, by: filter.by, q: filter.q, ...set };
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(cur)) if (v) u.set(k, v);
    router.push(u.toString() ? `${pathname}?${u}` : pathname);
  };
  const s = view.sum;
  const mb = s.bytes / 1024 / 1024;
  const th = "border-b border-line bg-[#fafbfc] px-3 py-[9px] text-left text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-muted uppercase";
  const td = "border-b border-divider px-3 py-2.5 text-[12.8px] whitespace-nowrap text-body";
  const periodWord = filter.period === "month" ? "this month" : filter.period === "last" ? "last month" : "in all";

  return (
    <div className="px-6 pt-5 pb-12">
      <div className="mb-3.5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-heading">Upload history</h1>
          <div className="mt-0.5 text-[12.5px] text-muted">Who uploaded what, what it brought in, and how long the PDF is kept.</div>
        </div>
        <Link href="/accounts/bank-statements?new=1" className="ml-auto inline-flex h-[34px] items-center rounded-[9px] border border-brand bg-brand px-3.5 text-[13px] font-[650] text-white no-underline hover:bg-brand-hover hover:no-underline">
          ⤒ Upload bank PDF
        </Link>
      </div>

      <div className="mb-3.5 flex overflow-hidden rounded-[12px] border border-line bg-surface">
        {[
          [`Uploads ${periodWord}`, String(s.n)],
          ["Lines brought in", s.brought.toLocaleString("en-IN")],
          ["Skipped as already in", s.skipped.toLocaleString("en-IN")],
          ["PDFs stored now", `${s.kept} · ${mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(s.bytes / 1024)} KB`}`],
          [`Pages read by AI ${periodWord}`, String(s.pages)],
        ].map(([l, v], i, all) => (
          <div key={l} className={cx("flex-1 px-4 py-3", i < all.length - 1 && "border-r border-divider")}>
            <div className="text-[11.5px] font-semibold text-muted">{l}</div>
            <div className="text-[19px] font-[750] text-heading tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-divider px-3 py-2.5">
          <Sel value={filter.account ?? ""} onChange={(e) => go({ account: e.target.value || null })}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Sel>
          <Sel value={filter.period} onChange={(e) => go({ period: e.target.value === "month" ? null : e.target.value })}>
            <option value="month">This month</option>
            <option value="last">Last month</option>
            <option value="all">Any time</option>
          </Sel>
          <Sel value={filter.by ?? ""} onChange={(e) => go({ by: e.target.value || null })}>
            <option value="">Uploaded by anyone</option>
            {view.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Sel>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              go({ q: q.trim() || null });
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search file name…" className="h-8 w-[220px] rounded-[8px] border border-line px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-brand" />
          </form>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>Uploaded</th>
              <th className={th}>Account</th>
              <th className={th}>File</th>
              <th className={th}>Statement period</th>
              <th className={cx(th, "text-right")}>Read</th>
              <th className={cx(th, "text-right")}>New</th>
              <th className={th}>Balance check</th>
              <th className={th}>PDF</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {view.rows.map((u) => {
              const ret = retention(u, today);
              const n = u.status === "imported" ? u.imported : u.fresh;
              return (
                <tr key={u.id}>
                  <td className={td}>
                    <b className="font-[650] text-ink">
                      {dayLabel(istDay(u.uploadedAt))}, {timeLabel(u.uploadedAt)}
                    </b>
                    <div className="text-[11.5px] text-muted">{u.uploadedBy ?? "—"}</div>
                  </td>
                  <td className={td}>
                    <Acc mark={u.mark} name={u.account} last4={u.last4} />
                  </td>
                  <td className={cx(td, "max-w-[190px] overflow-hidden font-mono text-[12px] text-ellipsis text-brand-deep")} title={u.fileName}>
                    {u.fileName}
                  </td>
                  <td className={cx(td, "max-w-[190px] overflow-hidden text-ellipsis")} title={u.periodFrom ? `${u.periodFrom} – ${u.periodTo ?? "…"}` : undefined}>
                    {u.periodFrom ? `${u.periodFrom} – ${u.periodTo ?? "…"}` : "—"}
                  </td>
                  <td className={cx(td, "text-right tabular-nums")}>{u.status === "reading" ? "…" : u.read}</td>
                  <td className={cx(td, "text-right tabular-nums")}>
                    <b className="font-[650] text-ink">{u.status === "reading" ? "…" : n}</b>
                  </td>
                  <td className={td}>
                    {u.status === "reading" ? (
                      <Pill tone="ai">Reading…</Pill>
                    ) : u.status === "failed" ? (
                      <Pill tone="danger">Could not read</Pill>
                    ) : u.status === "discarded" ? (
                      <Pill tone="muted">Discarded</Pill>
                    ) : u.balanceOk ? (
                      <Pill tone="ok">Agrees</Pill>
                    ) : (
                      <Pill tone="flag">Breaks at line {u.breakAt ?? "?"}</Pill>
                    )}
                  </td>
                  <td className={td}>
                    <Ret tone={ret.tone}>{ret.text}</Ret>
                  </td>
                  <td className={cx(td, "whitespace-normal")}>
                    {u.pdfKept ? (
                      <>
                        <a href={`/api/accounts/bank-statements/${u.id}/pdf`} target="_blank" rel="noreferrer" className="font-semibold text-brand hover:underline">
                          View PDF ↗
                        </a>
                        {u.status === "imported" ? (
                          <>
                            {" · "}
                            <Link href={`/accounts/bank-reconcile?upload=${u.id}&tab=all`} className="font-semibold text-brand hover:underline">
                              lines
                            </Link>
                          </>
                        ) : u.status === "ready" ? (
                          <>
                            {" · "}
                            <Link href={`/accounts/bank-statements?upload=${u.id}`} className="font-semibold text-brand hover:underline">
                              check and import
                            </Link>
                          </>
                        ) : null}
                      </>
                    ) : u.status === "imported" ? (
                      <span className="text-[11.5px] text-muted">
                        Lines kept ·{" "}
                        <Link href={`/accounts/bank-reconcile?upload=${u.id}&tab=all`} className="font-semibold text-brand hover:underline">
                          see {u.imported} line{u.imported === 1 ? "" : "s"}
                        </Link>
                      </span>
                    ) : (
                      <span className="text-[11.5px] text-muted">{u.error ? u.error.slice(0, 60) : "—"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!view.rows.length ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-[12.5px] text-muted">
                  No uploads {periodWord}.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Note tone="i" className="mt-3">
        The PDF is deleted {retentionDays} days after upload by the hourly clean-up. The upload row, the lines, every match and who made it are kept. Each line still says which upload it came from.
      </Note>
    </div>
  );
}
