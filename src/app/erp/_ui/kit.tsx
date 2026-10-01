"use client";

import { createContext, useContext } from "react";
import type { FormSpec, Tone } from "@/lib/erp/ui";
import { FLAG, ST_TONE } from "@/lib/erp/ui";
import type { Result } from "@/lib/result";
import { erpLoadForm, erpRunAction, erpRunBulk, erpSubmitForm } from "@/lib/actions/erp";

/* ---------------------------------------------------------------------------
 * What makes the generic screens one app's rather than another's.
 *
 * The list screen, the record drawer, the form drawer and the prompt were
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
};

export const ERP_KIT: ScreenKit = {
  runAction: erpRunAction,
  runBulk: erpRunBulk,
  submitForm: erpSubmitForm,
  loadForm: erpLoadForm,
  uploadUrl: "/api/erp/attachments",
  flags: FLAG,
  tones: ST_TONE,
  place: { one: "godown", many: "godowns" },
};

export const KitContext = createContext<ScreenKit>(ERP_KIT);

export function useKit(): ScreenKit {
  return useContext(KitContext);
}
