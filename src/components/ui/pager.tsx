"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";

/* ------------------------------------------------------------------- pager */

/**
 * Paging over a filtered set.
 *
 * The note beside it is not decoration: every screen that pages here also
 * shows a total, an aging strip or an export describing the WHOLE filtered
 * set, and a reader is entitled to know the figures above are not the page
 * below.
 */
export function Pager({
  total,
  page,
  perPage,
  note,
  onPage,
  onPerPage,
  look,
}: {
  total: number;
  page: number;
  perPage: number;
  note?: string;
  onPage: (p: number) => void;
  onPerPage: (n: number) => void;
  /** "v4": the ERP v4 footer — a rows switch, the range, numbered pages. Same choices, drawn its way. */
  look?: "v4";
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const at = Math.min(page, pages);
  const from = (at - 1) * perPage;

  if (look === "v4") {
    /* Every page stays one click away: the first, the last, and the two
       either side of where you are, with ‹ › to step. */
    const nums = [...new Set([1, at - 1, at, at + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    const items: (number | "gap")[] = [];
    nums.forEach((n, i) => {
      if (i > 0 && n - nums[i - 1] > 1) items.push("gap");
      items.push(n);
    });
    const step = "flex h-7.5 min-w-7.5 items-center justify-center rounded-md px-1.5 text-[13px]";
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[13px] text-muted">
        <span className="flex flex-none items-center gap-2">
          Rows per page
          <span role="group" aria-label="Rows per page" className="flex gap-0.5 rounded-[7px] bg-[#E4E9F1] p-0.5">
            {[25, 50, 100].map((n) => (
              <button
                key={n}
                onClick={() => onPerPage(n)}
                aria-pressed={perPage === n}
                className={cx(
                  "cursor-pointer rounded-[5px] px-2.5 py-0.5 text-[12.5px]",
                  perPage === n ? "bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(20,20,30,0.08)]" : "font-medium text-muted hover:text-ink",
                )}
              >
                {n}
              </button>
            ))}
          </span>
        </span>
        <span className="min-w-0 truncate">
          {total ? `${from + 1}–${Math.min(total, from + perPage)} of ${total.toLocaleString("en-IN")}` : "No rows"}
          {note ? ` · ${note}` : ""}
        </span>
        {total > perPage ? (
          <span className="flex flex-none items-center gap-1">
            <button
              onClick={at > 1 ? () => onPage(at - 1) : undefined}
              disabled={at <= 1}
              aria-label="Previous page"
              title={at > 1 ? "Previous page" : "You are on the first page"}
              className={cx(step, at > 1 ? "cursor-pointer hover:bg-divider" : "cursor-not-allowed text-line-strong")}
            >
              ‹
            </button>
            {items.map((n, i) =>
              n === "gap" ? (
                <span key={`gap${i}`} className={step}>
                  …
                </span>
              ) : (
                <button
                  key={n}
                  onClick={() => onPage(n)}
                  aria-current={n === at ? "page" : undefined}
                  className={cx(step, "cursor-pointer", n === at ? "bg-brand-soft font-semibold text-brand-hover" : "font-medium hover:bg-divider")}
                >
                  {n}
                </button>
              ),
            )}
            <button
              onClick={at < pages ? () => onPage(at + 1) : undefined}
              disabled={at >= pages}
              aria-label="Next page"
              title={at < pages ? "Next page" : "You are on the last page"}
              className={cx(step, at < pages ? "cursor-pointer hover:bg-divider" : "cursor-not-allowed text-line-strong")}
            >
              ›
            </button>
          </span>
        ) : (
          <span />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-divider bg-canvas px-5 py-2.5">
      <span className="text-[13px] whitespace-nowrap text-muted">
        {total
          ? `Showing ${from + 1}–${Math.min(total, from + perPage)} of ${total.toLocaleString("en-IN")}`
          : "No rows"}
      </span>
      {note ? (
        <span className="min-w-0 truncate text-[13px] text-muted">· {note}</span>
      ) : null}
      <span className="min-w-2 flex-1" />

      <span className="flex flex-none items-center gap-1.5">
        <span className="text-[13px] whitespace-nowrap text-muted">Rows</span>
        {[25, 50, 100].map((n) => (
          <button
            key={n}
            onClick={() => onPerPage(n)}
            className={cx(
              "h-7 cursor-pointer rounded-control border px-2.5 text-[13px]",
              perPage === n
                ? "border-brand bg-brand-soft font-medium text-brand-hover"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            {n}
          </button>
        ))}
      </span>

      {total > perPage ? (
        <span className="flex flex-none items-center gap-2">
          <span className="h-5 w-px bg-line" />
          <span className="text-[13px] whitespace-nowrap text-muted">
            Page {at} of {pages}
          </span>
          <PageButton
            enabled={at > 1}
            onClick={() => onPage(at - 1)}
            disabledTitle="You are on the first page"
          >
            Previous
          </PageButton>
          <PageButton
            enabled={at < pages}
            onClick={() => onPage(at + 1)}
            disabledTitle="You are on the last page"
          >
            Next
          </PageButton>
        </span>
      ) : null}
    </div>
  );
}

function PageButton({
  enabled,
  onClick,
  disabledTitle,
  children,
}: {
  enabled: boolean;
  onClick: () => void;
  disabledTitle: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      title={enabled ? undefined : disabledTitle}
      className={cx(
        "h-7 rounded-control border border-line bg-surface px-2.5 text-[13px]",
        enabled ? "cursor-pointer text-body hover:bg-canvas" : "cursor-not-allowed text-line-strong",
      )}
    >
      {children}
    </button>
  );
}
