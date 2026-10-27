"use client";

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import { ACTION_NOT_FOUND_HEADER, isStaleBuildError, nextPollMs, safeToReload } from "@/lib/version-skew";

/* ---------------------------------------------------------------------------
 * KEEPS AN OPEN TAB ON THE BUILD THAT IS SERVING — one per tab, in the root
 * layout, so every app has it. See `lib/version-skew.ts` for why.
 *
 * Next's own guard (`deploymentId`) reloads a stale tab only when it NAVIGATES,
 * and the screens where people save — every ERP dialog, the call drawer, the
 * collections panel — open in place and never navigate. So this asks
 * `/api/version` when the tab comes back into view and every few minutes, and
 * where the answer differs from the build the page was rendered by:
 *
 *   - an idle tab (no dialog open, nothing being typed) reloads on the spot,
 *     which is the ordinary case: somebody comes back from lunch to a page
 *     that is already current before they touch it;
 *   - a busy one gets a line at the top instead, and reloads itself the moment
 *     it is idle — a reload is never allowed to eat a half-typed form.
 *
 * And where a save WAS refused for being from the old build, it says so in
 * words, over whatever the screen did with the error: nothing was saved,
 * reload and do it again. It watches every `fetch` for Next's not-found marker,
 * so this holds for every action in every app, including the ones whose
 * caller swallows the throw.
 *
 * A FEW HUNDRED TABS ARE OPEN AT ONCE, so the poll is jittered, the endpoint
 * touches no database, and nothing reloads the whole team in the same second
 * after a deploy: each tab moves when it is next looked at or next idle.
 * ------------------------------------------------------------------------- */

const POLL_MS = 5 * 60_000;
const IDLE_RECHECK_MS = 15_000;
/** One automatic reload per new build per tab — never a loop. */
const RELOADED_KEY = "mahek.version.reloadedFor";

type State = "current" | "newer" | "refused";

/** The build this page's code came from, inlined by next.config.ts. */
const PAGE_BUILD = process.env.MAHEK_BUILD ?? "dev";

function alreadyReloadedFor(id: string): boolean {
  try {
    return sessionStorage.getItem(RELOADED_KEY) === id;
  } catch {
    return false;
  }
}

function markReloadedFor(id: string) {
  try {
    sessionStorage.setItem(RELOADED_KEY, id);
  } catch {
    /* private mode — the banner still covers it */
  }
}

export function VersionGuard() {
  const [state, setState] = React.useState<State>("current");
  const stateRef = React.useRef<State>("current");
  const serverRef = React.useRef<string | null>(null);

  const flag = React.useCallback((next: State) => {
    // "refused" outranks "newer": once a save has been lost, say so.
    if (stateRef.current === "refused") return;
    stateRef.current = next;
    setState(next);
  }, []);

  /* Every fetch, every app: a POST the server answered "no such action". */
  React.useEffect(() => {
    const original = window.fetch;
    const patched: typeof window.fetch = async (...args) => {
      const res = await original(...args);
      if (res.headers.get(ACTION_NOT_FOUND_HEADER) === "1") flag("refused");
      return res;
    };
    window.fetch = patched;
    const onError = (e: ErrorEvent) => {
      if (isStaleBuildError(e.error ?? e.message)) flag("refused");
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isStaleBuildError(e.reason)) flag("refused");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      if (window.fetch === patched) window.fetch = original;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [flag]);

  /* Is there a newer build? Asked on return to the tab and on a jittered beat. */
  React.useEffect(() => {
    const mine = PAGE_BUILD;
    if (mine === "dev") return; // local dev: no deployment id, nothing to skew against
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;

    const reloadIfIdle = () => {
      const server = serverRef.current;
      if (!server || stateRef.current !== "newer") return;
      if (alreadyReloadedFor(server)) return; // tried once; the banner stays
      if (document.visibilityState === "visible" && safeToReload(document)) {
        markReloadedFor(server);
        window.location.reload();
      }
    };

    const check = async () => {
      if (inflight || document.visibilityState !== "visible") return;
      inflight = true;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { id } = (await res.json()) as { id: string | null };
        if (id && id !== mine) {
          serverRef.current = id;
          flag("newer");
          reloadIfIdle();
        }
      } catch {
        /* offline or mid-deploy: ask again next time */
      } finally {
        inflight = false;
      }
    };

    const schedule = () => {
      timer = setTimeout(() => {
        void check().finally(schedule);
      }, stateRef.current === "newer" ? IDLE_RECHECK_MS : nextPollMs(POLL_MS, Math.random()));
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (stateRef.current === "newer") reloadIfIdle();
      else void check();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [flag]);

  if (state === "current") return null;

  if (state === "newer") {
    return (
      <div className="fixed inset-x-0 top-2 z-[1000] flex justify-center px-4 pointer-events-none">
        <div
          role="status"
          className="pointer-events-auto flex items-center gap-3 rounded-lg border border-warn-line bg-warn-soft px-4 py-2 text-sm text-warn-ink shadow-md"
        >
          <span>MahekOne has been updated. Finish what you are doing, then reload.</span>
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/40 px-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="version-guard-title"
        className="w-full max-w-md rounded-xl bg-surface p-6 shadow-xl"
      >
        <h2 id="version-guard-title" className="text-base font-semibold text-heading">
          That was not saved
        </h2>
        <p className="mt-2 text-sm text-body">
          MahekOne was updated while this page was open, so the server could not accept it. Reload the page and do it
          again — it will go through.
        </p>
        <p className="mt-2 text-sm text-muted">
          Anything typed into the form is lost on reload, so copy it first if it was long.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              // Back to the banner; a second refused save opens this again.
              stateRef.current = "newer";
              setState("newer");
            }}
          >
            Copy first
          </Button>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload now
          </Button>
        </div>
      </div>
    </div>
  );
}
