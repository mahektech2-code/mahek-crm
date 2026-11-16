/* ---------------------------------------------------------------------------
 * A ROW'S DRAWER IS BUILT WHEN SOMETHING READS IT.
 *
 * A list module builds a row for every line its list could show, because the
 * search, the chips, the sort and the figure cards are worked out over all of
 * them (`pageOf`) — and those read only a row's id, its values and its flags.
 * The rest of a row is what its record dialog draws: twenty-odd fields and as
 * many actions, each with its prompt, its sentence and its link. On Orders
 * that was most of what the server allocated to draw a page: nine hundred
 * rows' worth of drawers built to send twenty-five of them.
 *
 * `later(build)` marks a part as built on first read, and `withLater` turns
 * every such part into a property that builds it then and keeps it. Anything
 * that reads the row — the page cut sending it, a bulk action judging it, a
 * form opened from it, a test — gets exactly what an eager build would have
 * given it; a row nobody reads costs only what the list needs of it.
 * ------------------------------------------------------------------------- */

class Later<T> {
  constructor(readonly build: () => T) {}
}

/** A part of a row worked out the first time it is read. */
export function later<T>(build: () => T): Later<T> {
  return new Later(build);
}

/** The row with every `later` part as a property that builds itself once, in the same key order. */
export function withLater<T extends object>(parts: { [K in keyof T]: T[K] | Later<T[K]> }): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(parts)) {
    if (!(v instanceof Later)) {
      (out as Record<string, unknown>)[k] = v;
      continue;
    }
    const keep = (value: unknown) => Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(out, k, {
      enumerable: true,
      configurable: true,
      get() {
        const value = (v as Later<unknown>).build();
        keep(value);
        return value;
      },
      set: keep,
    });
  }
  return out;
}
