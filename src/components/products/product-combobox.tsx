"use client";

import * as React from "react";
import { productLines } from "@/lib/catalogue";
import { Input, cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * ONE BOX THAT IS BOTH THE ANSWER AND THE CATALOGUE.
 *
 * Lead intake used to draw a text box and, beneath it, a second search box with
 * its own "nothing chosen" line — two places for one answer. This is a single
 * field: click it and every active Mahek product is offered, type and the list
 * narrows, pick one and its name is the value. Nothing forces a choice — words
 * that match nothing are kept as typed, which is what the field has always
 * meant — and editing the box after a pick drops the pick, so what is shown is
 * always what will be saved.
 *
 * It reads the same endpoint the other pickers read (`/api/product-search`),
 * with `?all=1` for the whole active list, fetched the first time the box is
 * opened rather than with the page. If nothing local matches, the existing
 * search is asked as well, so a misspelling or an old name (`product_aliases`)
 * still finds its product.
 * ------------------------------------------------------------------------- */

export type CatalogueOption = {
  productId: string;
  name: string;
  displayName: string;
  subtitle: string | null;
  brand?: string | null;
};

export function ProductCombobox({
  text,
  productId,
  onText,
  onPick,
  placeholder,
  invalid,
}: {
  /** What the box shows: typed words, or the name of the chosen product. */
  text: string;
  /** Set only while the text IS a catalogue pick. Editing the text clears it. */
  productId: string | null;
  /** Words typed (or cleared) by the person — never a catalogue pick. */
  onText: (text: string) => void;
  /** A product chosen from the list, or null when the pick is cleared. */
  onPick: (product: { productId: string; name: string } | null) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const listId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [options, setOptions] = React.useState<CatalogueOption[] | null>(null);
  const [load, setLoad] = React.useState<"idle" | "loading" | "failed">("idle");
  /* The existing search's answer for ONE query — kept beside the query it
     answers, so a stale result is never shown under a newer string. */
  const [fallback, setFallback] = React.useState<{ query: string; rows: CatalogueOption[] } | null>(
    null,
  );

  const q = text.trim().toLowerCase();

  async function ensureLoaded() {
    if (options !== null || load === "loading") return;
    setLoad("loading");
    try {
      const res = await fetch("/api/product-search?all=1");
      const body = (await res.json()) as { products?: CatalogueOption[] };
      setOptions(body.products ?? []);
      setLoad("idle");
    } catch {
      setLoad("failed");
    }
  }

  const matches = React.useMemo(() => {
    if (!options) return [];
    // A chosen product's own name must not filter the list down to itself.
    if (productId || !q) return options;
    const tokens = q.split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const hay = `${o.name} ${o.subtitle ?? ""} ${o.brand ?? ""}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [options, q, productId]);

  const wantsFallback = open && !productId && options !== null && matches.length === 0 && q.length >= 2;

  React.useEffect(() => {
    if (!wantsFallback) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/product-search?q=${encodeURIComponent(q)}`);
        const body = (await res.json()) as { products?: CatalogueOption[] };
        if (live) setFallback({ query: q, rows: body.products ?? [] });
      } catch {
        if (live) setFallback({ query: q, rows: [] });
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wantsFallback, q]);

  const shown: CatalogueOption[] =
    matches.length > 0 ? matches : fallback && fallback.query === q && !productId ? fallback.rows : [];
  const index = Math.min(active, Math.max(shown.length - 1, 0));

  function pick(o: CatalogueOption) {
    onPick({ productId: o.productId, name: o.name });
    setOpen(false);
  }

  function scrollTo(i: number) {
    requestAnimationFrame(() => {
      document.getElementById(`${listId}-${i}`)?.scrollIntoView({ block: "nearest" });
    });
  }

  let status: string | null = null;
  if (load === "failed") {
    status = "The catalogue could not be loaded — type what they want in your own words.";
  } else if (options === null) {
    status = "Loading Mahek products…";
  } else if (shown.length === 0) {
    status = q
      ? "No Mahek product matches. What you have typed will be saved as your own words."
      : "There are no active products to offer.";
  }

  return (
    <div
      className="relative"
      onBlur={(e) => {
        // Closed only when focus leaves the whole field, so a click on an option still lands.
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <Input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown.length ? `${listId}-${index}` : undefined}
        autoComplete="off"
        value={text}
        invalid={invalid}
        placeholder={placeholder}
        className={productId ? "pr-8" : undefined}
        onFocus={() => {
          setOpen(true);
          void ensureLoaded();
        }}
        onChange={(e) => {
          onText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            void ensureLoaded();
            const next = Math.min(index + 1, shown.length - 1);
            setActive(next);
            scrollTo(next);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const next = Math.max(index - 1, 0);
            setActive(next);
            scrollTo(next);
          } else if (e.key === "Enter" && open && shown[index]) {
            e.preventDefault();
            pick(shown[index]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {productId ? (
        <button
          type="button"
          aria-label="Clear the chosen product"
          title="Clear the chosen product"
          className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer border-0 bg-transparent p-0 text-[16px] leading-none text-muted hover:text-ink"
          onClick={() => {
            onPick(null);
            setOpen(false);
          }}
        >
          ×
        </button>
      ) : null}

      {open ? (
        <div className="absolute z-20 mt-1 w-full rounded-[4px] border border-line bg-surface shadow-md">
          {status ? (
            <div className="px-2.5 py-2 text-[12px] text-muted">{status}</div>
          ) : (
            <ul
              id={listId}
              role="listbox"
              className="m-0 max-h-[260px] list-none overflow-y-auto p-0"
            >
              {shown.map((o, i) => {
                const row = productLines(o);
                return (
                  <li
                    key={o.productId}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={o.productId === productId}
                    className={cx(
                      "cursor-pointer border-b border-divider px-2.5 py-1.5 last:border-b-0",
                      i === index ? "bg-canvas" : "",
                    )}
                    // Held on mousedown so the input keeps focus and the click is not lost to the blur.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o)}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span className="block text-[13px] text-ink">{row.lead}</span>
                    {row.detail ? (
                      <span className="block text-[12px] text-muted">{row.detail}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
