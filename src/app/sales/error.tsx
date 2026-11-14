"use client";

import * as React from "react";

/**
 * WHEN A SCREEN THROWS, SAY SO HERE RATHER THAN LOSING THE CONSOLE.
 *
 * There was no error boundary anywhere in MahekOne — not in this app, not at
 * the root — so a query that threw took the whole document to Next's own
 * default page: no sidebar, no header, no way back except the browser. On a
 * console somebody works in all day that reads as the product being down,
 * whichever one screen actually failed.
 *
 * Placed at `/sales` rather than at the root deliberately: the shell lives in
 * `layout.tsx`, and a boundary INSIDE the layout keeps the sidebar and the
 * header drawn, so the failure is one screen's and every other destination is
 * still one click away.
 *
 * **It does not print the error.** A stack or a Postgres message tells a
 * manager nothing and can carry a column name, a value or a fragment of
 * somebody's data. `digest` is the id the server log is searchable by, which
 * is the thing that is actually worth quoting to whoever fixes it.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[sales]", error);
  }, [error]);

  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
        <div className="text-lg font-semibold text-ink">This screen could not be drawn</div>
        <p className="mx-auto mt-1.5 max-w-[520px] text-[15px] text-pretty text-muted">
          Nothing has been changed and nothing has been lost — this is a read that
          failed. Try it again; if it keeps failing, every other screen in the
          console is still working and this one wants somebody to look at it.
        </p>
        {error.digest ? (
          <p className="mt-2 text-[13px] text-muted">
            Quote this when you report it: <span className="font-medium text-body">{error.digest}</span>
          </p>
        ) : null}
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 cursor-pointer items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
          >
            Try again
          </button>
          <a
            href="/sales"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Back to Today
          </a>
        </div>
      </div>
    </div>
  );
}
