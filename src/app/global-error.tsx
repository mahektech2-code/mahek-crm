"use client";

import * as React from "react";
import { isStaleBuildError } from "@/lib/version-skew";

/**
 * WHEN THE ROOT LAYOUT ITSELF THROWS. `error.tsx` beside this sits inside the
 * layout and catches nearly everything; this is the last line, and it has to
 * draw its own `<html>` because the layout is what failed. Without it Next
 * showed "This page couldn't load", which is true and tells somebody nothing —
 * least of all, after a deploy, that what they just sent was not saved.
 * Inline styles: the stylesheet may be part of what did not load.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  React.useEffect(() => {
    console.error("[global]", error);
  }, [error]);

  const stale = isStaleBuildError(error);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f7f8fa", color: "#161616" }}>
        <div style={{ maxWidth: 520, margin: "18vh auto", padding: "0 16px", textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
            {stale ? "MahekOne was updated — that was not saved" : "MahekOne could not load this page"}
          </h1>
          <p style={{ fontSize: 15, color: "#6b7385", marginTop: 8 }}>
            {stale
              ? "This page was opened before the latest update, so the server could not accept what you sent. Reload and do it again — it will go through."
              : "Reload to try again. If it keeps happening, report it with the code below."}
          </p>
          {error.digest ? <p style={{ fontSize: 13, color: "#6b7385" }}>Code: {error.digest}</p> : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: 12, height: 36, padding: "0 16px", border: 0, borderRadius: 4, background: "#6835fb", color: "#fff", fontSize: 14, cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
