import * as React from "react";

/**
 * The fields of an editor, READ-ONLY while a request holds the item.
 *
 * A disabled Save is not enough: somebody could type for ten minutes into a box
 * the server was always going to refuse, and lose it. A disabled `<fieldset>`
 * turns off every input, text box, selector and button inside it at once — the
 * "Add paragraph" and "Change image" buttons too — so nothing can be typed or
 * changed in the first place. What was there stays on the screen, dimmed, to be
 * read; the banner above it says why and how to get it back.
 *
 * Its own file, with nothing to import but React, so a test can render it.
 */
export function LockedFields({ locked, children }: { locked: boolean; children: React.ReactNode }) {
  return (
    <fieldset disabled={locked} data-locked={locked ? "true" : undefined} className={`m-0 min-w-0 border-0 p-0 ${locked ? "opacity-70" : ""}`}>
      {children}
    </fieldset>
  );
}
