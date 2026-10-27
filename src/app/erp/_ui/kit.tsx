"use client";

import { createContext, useContext } from "react";
import type { FormSpec, Tone } from "@/lib/erp/ui";
import { FLAG, ST_TONE } from "@/lib/erp/ui";
import type { Result } from "@/lib/result";
import { actionFailure } from "@/lib/version-skew";
import { erpListExport, erpListIds, erpLoadForm, erpRunAction, erpRunBulk, erpRunTool, erpSubmitForm } from "@/lib/actions/erp";

/* ---------------------------------------------------------------------------
 * What makes the generic screens one app's rather than another's.
 *
 * The list screen, the record dialog, the form dialog and the prompt were
 * written for the ERP and are not about the ERP at all: they draw what a
 * server module sent and ask the server to act. Four things tied them to it —
 * the four server actions they call, the upload endpoint a photo field posts
 * to, and the vocabulary of flags and status tones. A kit carries those four,
 * so HRMS draws its screens with the same components rather than a copy of
 * them that would drift from the ERP's inside a release.
 *
 * The ERP's kit is the default, so nothing in the ERP had to change to keep
 * working.
 * ------------------------------------------------------------------------- */

export type ScreenKit = {
  runAction: (screen: string, action: string, id: string, values?: Record<string, string>) => Promise<Result<unknown>>;
  runBulk: (screen: string, action: string, ids: string[], values?: Record<string, string>) => Promise<Result<unknown>>;
  submitForm: (
    screen: string,
    form: string,
    header: Record<string, string>,
    lines: Record<string, string>[],
    recordId?: string,
  ) => Promise<Result<unknown>>;
  loadForm: (screen: string, action: string, id: string) => Promise<Result<FormSpec>>;
  /** Runs a header tool (ToolSpec); absent where the app has none. */
  runTool?: (screen: string, tool: string, values?: Record<string, string>) => Promise<Result<unknown>>;
  /** A server-paged list's whole filtered set, as CSV; absent where every list is sent whole. */
  exportList?: (screen: string, query: Record<string, string>) => Promise<Result<{ csv: string; n: number }>>;
  /** A server-paged list's filtered ids, for "Select all" across pages. */
  listIds?: (screen: string, query: Record<string, string>) => Promise<Result<string[]>>;
  /** Where a photo or video field posts the file it was given. */
  uploadUrl: string;
  /** Where a pin field asks for the map key; absent, the pin is typed. */
  mapKeyUrl?: string;
  /** Named row states and how each is labelled. */
  flags: Record<string, [string, Tone]>;
  /** The tone a status value is drawn in. */
  tones: Record<string, Tone>;
  /** What the list's location filter calls its places ("godown", "office"). */
  place: { one: string; many: string };
  /** "v4": the ERP's v4 list head — chips as figure cards, filters on the page. Absent, the original look. */
  look?: "v4";
};

export const ERP_KIT: ScreenKit = {
  runAction: erpRunAction,
  runBulk: erpRunBulk,
  submitForm: erpSubmitForm,
  loadForm: erpLoadForm,
  runTool: erpRunTool,
  exportList: erpListExport,
  listIds: erpListIds,
  uploadUrl: "/api/erp/attachments",
  mapKeyUrl: "/api/erp/map-key",
  flags: FLAG,
  tones: ST_TONE,
  place: { one: "godown", many: "godowns" },
  look: "v4",
};

export const KitContext = createContext<ScreenKit>(ERP_KIT);

/*
 * A CALL THAT THROWS ANSWERS LIKE ONE THAT REFUSED. Every dialog here awaits
 * the kit and reads `res.ok`; none of them catches, so an action that threw —
 * a tab older than the deploy, a dropped connection — left the button busy for
 * ever with no sentence on the screen, and the save looked like it had simply
 * not happened. Wrapped once here, every caller gets an `Err` it already knows
 * how to draw. Cached per kit so `useKit()` hands back the same object each
 * render.
 */
const SAFE = new WeakMap<ScreenKit, ScreenKit>();

function guard<A extends unknown[], T>(fn: (...a: A) => Promise<Result<T>>): (...a: A) => Promise<Result<T>> {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      return { ok: false, error: actionFailure(e) };
    }
  };
}

export function safeKit(kit: ScreenKit): ScreenKit {
  let safe = SAFE.get(kit);
  if (!safe) {
    safe = {
      ...kit,
      runAction: guard(kit.runAction),
      runBulk: guard(kit.runBulk),
      submitForm: guard(kit.submitForm),
      loadForm: guard(kit.loadForm),
      runTool: kit.runTool && guard(kit.runTool),
      exportList: kit.exportList && guard(kit.exportList),
      listIds: kit.listIds && guard(kit.listIds),
    };
    SAFE.set(kit, safe);
    SAFE.set(safe, safe); // wrapping a wrapped kit hands it straight back
  }
  return safe;
}

export function useKit(): ScreenKit {
  return safeKit(useContext(KitContext));
}
