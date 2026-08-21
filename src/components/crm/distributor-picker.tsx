"use client";

import * as React from "react";
import { Icon } from "@/components/shell/icons";

export type DistributorCandidate = {
  id: string;
  name: string;
  city: string;
  /** Shops already served through them. */
  shops: number;
  /** Deliveries this account has already billed for. */
  deliveries: number;
};

/**
 * ONE picker for naming a distributor, wherever that is asked.
 *
 * It is always a search box and never a dropdown, for the reason the people
 * picker already documents: a list of eleven is fine as a `select` and a list
 * of five hundred and sixty-one is not, and building both means two components
 * and two sets of bugs. Five hundred and sixty-one is what this list is.
 *
 * WHAT IT OFFERS IS THE RULE, DRAWN. Only unmarked direct customers come back
 * from `/api/distributors/search` — somebody has to be holding the invoice at
 * the end of the chain — so a shop we deliver to cannot be picked here at all.
 * The action checks the same thing again: a picker is not a permission.
 *
 * The two numbers on each row are what makes the choice answerable by somebody
 * who does not know the book by heart. "Serves 12 shops" says this is one of
 * the distributors; "84 deliveries" says the order history already shows them
 * sending goods elsewhere.
 */
export function DistributorPicker({
  excludeCustomerId,
  exclude = [],
  onPick,
  autoFocus,
  placeholder = "Search direct customers by name, town or code",
}: {
  /** The shop being served — it may not be its own distributor. */
  excludeCustomerId?: string;
  /** Already named on this shop, so the same one cannot be added twice. */
  exclude?: string[];
  onPick: (candidate: DistributorCandidate) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = React.useState("");
  /*
   * The answer, TAGGED WITH THE QUESTION it answers — the same shape the
   * accounts payment search uses. Two things fall out of it: a slow response
   * for an earlier query cannot overwrite a newer one when it lands, and
   * "still searching" is derived from the tag not matching rather than from a
   * flag set in the effect body, which is what the React Compiler rules here
   * forbid.
   */
  const [remote, setRemote] = React.useState<{
    q: string;
    hits: DistributorCandidate[];
    more: number;
    /** Which rule answered — the server's, so the sentence below matches it. */
    mode: "prefix" | "wide";
  } | null>(null);
  const [failedFor, setFailedFor] = React.useState<string | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q });
        if (excludeCustomerId) params.set("exclude", excludeCustomerId);
        const res = await fetch(`/api/distributors/search?${params}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as {
          hits?: DistributorCandidate[];
          more?: number;
          mode?: "prefix" | "wide";
        };
        setRemote({
          q,
          hits: data.hits ?? [],
          more: data.more ?? 0,
          mode: data.mode ?? "wide",
        });
      } catch (e) {
        // An abort is the next keystroke, not a failure. Reporting it would
        // flash "could not search" between every two letters typed.
        if ((e as Error)?.name !== "AbortError") setFailedFor(q);
      }
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, excludeCustomerId]);

  const q = query.trim();
  const answer = remote && remote.q === q ? remote : null;
  const hits = answer?.hits ?? null;
  const failed = failedFor === q;

  const offered = (hits ?? []).filter((h) => !exclude.includes(h.id));

  return (
    <div>
      <div className="relative">
        <span className="pointer-events-none absolute top-[10px] left-2.5 text-muted">
          <Icon name="search" size={16} />
        </span>
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search for a distributor"
          className="h-9 w-full rounded-[4px] border border-line bg-surface pr-3 pl-8 text-sm focus:border-brand focus:outline-none"
        />
      </div>

      <div className="mt-2 max-h-[220px] overflow-y-auto rounded-[4px] border border-line">
        {/*
          THREE EMPTY STATES, SAID APART. Still searching, nothing matched, and
          the search itself failed are three different facts, and a list that
          means "wait" must never look like one that means "we have nobody like
          that" — the same rule the order form's product list follows.
        */}
        {failed ? (
          <p className="px-3 py-4 text-sm text-muted">
            The search did not answer. Try again in a moment.
          </p>
        ) : hits === null ? (
          <p className="px-3 py-4 text-sm text-muted">Searching…</p>
        ) : !offered.length ? (
          <p className="px-3 py-4 text-sm text-muted">
            {!q
              ? "No direct customers to offer."
              : answer?.mode === "prefix"
                ? // A short query searched the first letters and only those,
                  // so the sentence says that rather than implying the whole
                  // book was looked through and came back empty.
                  `No direct customer's name starts with "${q}". Keep typing to search inside names and towns too.`
                : "No direct customer matches that. A distributor has to be an account we bill ourselves."}
          </p>
        ) : (
          offered.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => onPick(h)}
              className="flex w-full items-center justify-between gap-3 border-b border-divider px-3 py-2 text-left last:border-b-0 hover:bg-canvas"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-ink">{h.name}</span>
                <span className="block text-[12px] text-muted">{h.city}</span>
              </span>
              <span className="shrink-0 text-right text-[12px] text-muted">
                {h.shops > 0 ? (
                  <span className="block">
                    serves {h.shops} shop{h.shops === 1 ? "" : "s"}
                  </span>
                ) : null}
                {h.deliveries > 0 ? (
                  <span className="block">
                    {h.deliveries} deliver{h.deliveries === 1 ? "y" : "ies"} billed
                  </span>
                ) : null}
              </span>
            </button>
          ))
        )}
        {/*
          THE CAP, SAID OUT LOUD. The list is trimmed to twenty and a list that
          simply stops looks like the whole answer — so somebody whose
          distributor is the twenty-first concludes we do not hold the account
          and goes looking for another way in. It names the number and what to
          do about it.
        */}
        {answer && answer.more > 0 && offered.length ? (
          <p className="border-t border-divider px-3 py-2 text-[12px] text-muted">
            {answer.more === 1
              ? "One more match is not shown."
              : `${answer.more} more matches are not shown.`}{" "}
            Type more of the name to narrow it.
          </p>
        ) : null}
      </div>
    </div>
  );
}
