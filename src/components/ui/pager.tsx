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
}: {
  total: number;
  page: number;
  perPage: number;
  note?: string;
  onPage: (p: number) => void;
  onPerPage: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const at = Math.min(page, pages);
  const from = (at - 1) * perPage;

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
              "h-7 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
              perPage === n
                ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
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
        "h-7 rounded-[4px] border border-line bg-surface px-2.5 text-[13px]",
        enabled ? "cursor-pointer text-body hover:bg-canvas" : "cursor-not-allowed text-line-strong",
      )}
    >
      {children}
    </button>
  );
}
