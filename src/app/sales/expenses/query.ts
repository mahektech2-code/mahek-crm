/* ---------------------------------------------------------------------------
 * Building an Expenses address. PURE and not a client module, because both
 * the server pages (chips, sort links) and the client controls build links,
 * and a plain function exported from a "use client" file becomes a client
 * reference a server component cannot call.
 * ------------------------------------------------------------------------- */

export type Query = Record<string, string | undefined>;

/** `base` with `query` merged over by `changes`; an empty value drops the key. */
export function hrefWith(
  base: string,
  query: Query,
  changes: Query = {},
): string {
  const merged: Query = { ...query, ...changes };
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`);
  return parts.length ? `${base}?${parts.join("&")}` : base;
}

/** `hrefWith` as the `keep` string `sortHref` takes (no leading `?`). */
export function keepString(query: Query, drop: string[] = []): string {
  return hrefWith(
    "",
    Object.fromEntries(
      Object.entries(query).filter(([k]) => !drop.includes(k)),
    ),
  ).replace(/^\?/, "");
}

/** The search params a page received, as plain strings. */
export function queryOf(
  params: Record<string, string | string[] | undefined>,
  keys: string[],
): Query {
  const out: Query = {};
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}
