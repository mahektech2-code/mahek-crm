/* ---------------------------------------------------------------------------
 * A TAB OLDER THAN THE SERVER IT IS TALKING TO.
 *
 * "I pressed Save, nothing happened; I refreshed and it saved" was this, every
 * time. A Server Action is called by an id the BUILD gives it, and a page holds
 * the ids of the build that rendered it. Deploy, and the tab left open since
 * the morning posts ids the new server has never heard of: Next answers 404
 * with `x-nextjs-action-not-found`, nothing is written, and the dialog that
 * awaited the call had no catch — so the button sat busy with no sentence at
 * all. A refresh fetched the new ids, which is why the second try worked.
 *
 * Three things answer it, and this file is the vocabulary all three share:
 *
 *   - the ids stop changing when the code did not (a fixed
 *     NEXT_SERVER_ACTIONS_ENCRYPTION_KEY at build — Next salts every id with
 *     it, and generated a fresh random one per build);
 *   - `VersionGuard` notices a newer deployment and reloads an idle tab before
 *     anybody types into it, and says so plainly where a save was refused;
 *   - every caller that awaits an action turns a THROW into a sentence rather
 *     than a frozen button, through `actionFailure`.
 *
 * Pure and client-safe: the guard and the ERP kit are client code.
 * ------------------------------------------------------------------------- */

/** The response header Next sets on a POST naming an action it does not have. */
export const ACTION_NOT_FOUND_HEADER = "x-nextjs-action-not-found";

export const STALE_SAVE_MESSAGE =
  "MahekOne was updated while this page was open, so this was not saved. Reload the page and do it again.";

export const UNREACHABLE_MESSAGE =
  "Could not reach MahekOne, so this was not saved. Check the connection and try again.";

/** Was this thrown because the page is from an older (or newer) build? */
export function isStaleBuildError(e: unknown): boolean {
  // Next's `UnrecognizedActionError`, matched by name rather than through
  // `next/navigation`, which drags the router into anything importing this.
  if (e instanceof Error && e.name === "UnrecognizedActionError") return true;
  const text = e instanceof Error ? `${e.name} ${e.message}` : typeof e === "string" ? e : "";
  return (
    /Server Action .* was not found on the server/i.test(text) ||
    /Failed to find Server Action/i.test(text) ||
    // A lazily loaded chunk the new image no longer carries.
    /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to load chunk/i.test(text)
  );
}

/** The sentence for an action that THREW rather than answering with a Result. */
export function actionFailure(e: unknown): string {
  return isStaleBuildError(e) ? STALE_SAVE_MESSAGE : UNREACHABLE_MESSAGE;
}

/**
 * Whether reloading now would cost somebody nothing they typed: no dialog
 * open, and the focus is not in something editable. A guess, deliberately on
 * the cautious side — a tab that is not reloaded shows a banner instead.
 */
export function safeToReload(doc: Pick<Document, "querySelector" | "activeElement">): boolean {
  if (doc.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return false;
  const a = doc.activeElement as HTMLElement | null;
  if (!a) return true;
  const tag = a.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || a.isContentEditable);
}

/** The next poll, spread so a few hundred tabs do not all ask in one second. */
export function nextPollMs(baseMs: number, rand: number): number {
  return Math.round(baseMs * (0.75 + rand * 0.5));
}
