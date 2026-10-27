"use client";

import * as React from "react";
import { isStaleBuildError } from "@/lib/version-skew";

/**
 * THE ROOT BOUNDARY, INSIDE THE ROOT LAYOUT — so `VersionGuard` and the bell
 * stay mounted when a screen throws.
 *
 * There was none, so anything that escaped a screen — above all a form whose
 * Server Action the server no longer recognised after a deploy — went to
 * Next's own "This page couldn't load", which replaces the document whole and
 * took the guard down with it. The one sentence that mattered ("this was not
 * saved, reload and do it again") was never said. Apps with their own boundary
 * (`/sales`, the lead pipeline) still catch first; this is everybody else.
 *
 * Like the `/sales` boundary it never prints the error, only the digest.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[root]", error);
  }, [error]);

  const stale = isStaleBuildError(error);

  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
        <div className="text-lg font-semibold text-ink">
          {stale ? "MahekOne was updated — that was not saved" : "This screen could not be drawn"}
        </div>
        <p className="mx-auto mt-1.5 max-w-[520px] text-[15px] text-pretty text-muted">
          {stale
            ? "This page was opened before the latest update, so the server could not accept what you sent. Reload and do it again — it will go through."
            : "Something on this screen failed. Reload to try again; if it keeps failing, report it with the code below."}
        </p>
        {error.digest ? (
          <p className="mt-2 text-[13px] text-muted">
            Quote this when you report it: <span className="font-medium text-body">{error.digest}</span>
          </p>
        ) : null}
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => (stale ? window.location.reload() : reset())}
            className="inline-flex h-9 cursor-pointer items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
          >
            {stale ? "Reload" : "Try again"}
          </button>
        </div>
      </div>
    </div>
  );
}
