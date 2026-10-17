"use client";

import { useCallback, useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
 * Which columns a person chose to see on a list, remembered per browser per
 * list — a standing preference about how they read that table, like a sort
 * (`use-remembered-sort.ts`). Null is the automatic set. Read through
 * `useSyncExternalStore` so the server render and the first client render
 * agree (null on both) and the remembered pick lands straight after.
 * ------------------------------------------------------------------------- */

const PREFIX = "mahekone.cols.";
const EVENT = "mahekone-cols";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useColumnChoice(key: string): [string[] | null, (keys: string[] | null) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const set = useCallback(
    (keys: string[] | null) => {
      try {
        if (keys) window.localStorage.setItem(PREFIX + key, keys.join(","));
        else window.localStorage.removeItem(PREFIX + key);
      } catch {
        // Storage refused: nothing is remembered and the automatic set stands.
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [raw ? raw.split(",").filter(Boolean) : null, set];
}
