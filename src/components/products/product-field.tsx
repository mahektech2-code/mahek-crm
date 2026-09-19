"use client";

import * as React from "react";
import { Input } from "@/components/ui/primitives";
import { plural } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * THE CATALOGUE PICKER, IN ONE PLACE, because it is now asked on two screens.
 *
 * It was a local function inside the qualification screen, which was right
 * while the qualification screen was the only thing that had to name a product.
 * Asking for a SAMPLE names one too — the same two hundred SKUs, the same
 * `/api/product-search`, the same three meanings of an empty list — and a
 * second copy typed into the sample form would be a second answer to "how does
 * somebody find Nano Thinner", free to drift the day the search endpoint gains
 * a parameter. The half that drifts is always the half somebody is reading
 * mid-call.
 * ------------------------------------------------------------------------- */

/**
 * Which of ours they need, searched rather than listed.
 *
 * Two hundred SKUs is a search box's job and not a list's — the catalogue is
 * never shipped to the browser, so this asks `/api/product-search` a keystroke
 * at a time exactly as the order form does. The name already on the lead is
 * kept and shown, so a picker nobody has searched yet still says what the
 * answer currently is rather than reading as empty.
 *
 * An empty list means THREE different things and says which: still searching,
 * nothing matched, and nothing typed yet. A list that means "wait" and one that
 * means "we do not sell that" must never look alike.
 */
export function ProductField({
  customerId,
  productId,
  productName,
  disabled,
  onPick,
}: {
  customerId: string;
  productId: string | null;
  productName: string | null;
  disabled: boolean;
  onPick: (id: string | null) => void;
}) {
  const [query, setQuery] = React.useState("");
  /*
   * THE RESULT CARRIES THE QUERY IT ANSWERS, which is what lets everything
   * below be derived rather than stored.
   *
   * The obvious shape is `rows` plus a `state`, cleared in an effect whenever
   * the box is emptied. The React Compiler lint refuses that and is right to:
   * a `setState` in an effect body is a second render on every keystroke, and
   * this one ran on a component inside a twelve-condition form. Worse, it is a
   * copy of a fact the query string already holds — "there is nothing to show
   * because nobody has typed two characters" is not state, it is arithmetic.
   *
   * Keeping the query beside its rows also fixes the flicker for free: a
   * result for "thin" is not shown under "thinner", because the two strings do
   * not match, so it reads as still searching rather than as a wrong answer.
   */
  const [result, setResult] = React.useState<{
    query: string;
    rows: Array<{ productId: string; displayName: string; subtitle: string | null }>;
  } | null>(null);
  const [pickedName, setPickedName] = React.useState<string | null>(productName);

  const q = query.trim();
  const searching = q.length >= 2;
  const rows = result && result.query === q ? result.rows : [];
  const state: "idle" | "searching" | "done" = !searching
    ? "idle"
    : result?.query === q
      ? "done"
      : "searching";

  React.useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/product-search?q=${encodeURIComponent(q)}&customerId=${encodeURIComponent(customerId)}`,
        );
        const body = (await res.json()) as {
          products?: Array<{ productId: string; displayName: string; subtitle: string | null }>;
        };
        if (live) setResult({ query: q, rows: body.products ?? [] });
      } catch {
        /* A search that did not answer is an empty list for THIS query, and
         * the screen says "nothing matched" rather than sitting on a spinner. */
        if (live) setResult({ query: q, rows: [] });
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, customerId]);

  return (
    <div>
      <div className="mb-1 text-[13px] text-body">
        {pickedName ? (
          <>
            <span className="font-medium text-ink">{pickedName}</span>
            {disabled ? null : (
              <button
                type="button"
                className="ml-2 cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted underline"
                onClick={() => {
                  setPickedName(null);
                  onPick(null);
                }}
              >
                change
              </button>
            )}
          </>
        ) : (
          <span className="text-muted">
            {productId
              ? "A product is set on this lead that the catalogue could not name."
              : "Nothing chosen"}
          </span>
        )}
      </div>

      {pickedName ? null : (
        <>
          <Input
            disabled={disabled}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the catalogue"
          />
          <div className="mt-1 text-[12px] text-muted">
            {query.trim().length < 2
              ? "Type two letters to search the catalogue."
              : state === "searching"
                ? "Searching…"
                : rows.length === 0
                  ? "Nothing in the catalogue matched that."
                  : plural(rows.length, "match", "matches")}
          </div>
          {rows.length ? (
            <ul className="mt-1 mb-0 max-h-[180px] list-none overflow-y-auto rounded-[4px] border border-line p-0">
              {rows.map((r) => (
                <li key={r.productId} className="border-b border-divider last:border-b-0">
                  <button
                    type="button"
                    className="w-full cursor-pointer border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-canvas"
                    onClick={() => {
                      setPickedName(r.displayName);
                      onPick(r.productId);
                      setQuery("");
                    }}
                  >
                    <span className="block text-[13px] text-ink">{r.displayName}</span>
                    {r.subtitle ? (
                      <span className="block text-[12px] text-muted">{r.subtitle}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
