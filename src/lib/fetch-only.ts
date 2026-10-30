/* ---------------------------------------------------------------------------
 * A file our own screens fetch in the background, and that must not open when
 * somebody types or pastes its address into the browser. Browsers say which
 * kind of request it is (Fetch Metadata): typing an address, following a link
 * or loading it into a frame is a NAVIGATION; our viewer's `fetch` is not.
 *
 * It closes the address bar, not every door: a request with no such headers
 * (an old browser, a script) is let through, and a signed-in person can still
 * save what our viewer received with the developer tools. Who may read the
 * file at all is still decided by `canRead`; this only decides HOW.
 * ------------------------------------------------------------------------- */

const FRAMING = new Set(["document", "iframe", "frame", "embed", "object"]);

/** True where the request is a page load or a frame rather than a fetch from one of our pages. */
export function isOpenedDirectly(headers: { get(name: string): string | null }): boolean {
  const mode = headers.get("sec-fetch-mode");
  const dest = headers.get("sec-fetch-dest");
  const site = headers.get("sec-fetch-site");
  if (mode === "navigate" || mode === "nested-navigate") return true;
  if (dest && FRAMING.has(dest)) return true;
  /* A fetch started by another site's page is not ours either. */
  if (site && site !== "same-origin") return true;
  return false;
}

export const OPENED_DIRECTLY_MESSAGE = "This invoice opens inside MahekOne. Open it from the order in the ERP.";
