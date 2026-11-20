"use client";

import { previewImpact } from "@/lib/actions/impact";
import { EFFECT_WORDS, type ImpactConfirmation, type ImpactReport } from "@/lib/impact/types";
import type { Result } from "@/lib/result";
import type { ModalSpec } from "./kit";

/* ---------------------------------------------------------------------------
 * THE IMPACT REPORT, IN THE LOCKER'S OWN MODAL. The Locker draws every dialog
 * through `useModal()`, so a retire reads the same report every other app's
 * `ImpactDialog` reads (`previewImpact`) and lays it out as the modal's notes:
 * each group in its effect's words, blockers first, then the name to type.
 * The act re-checks the report's fingerprint before it writes, exactly as
 * everywhere else; a `conflict` says the picture moved and asks again.
 * ------------------------------------------------------------------------- */

function notesOf(r: ImpactReport): ModalSpec["notes"] {
  const blockers = r.blockers.map((b) => ({ t: b, bg: "var(--color-danger-soft)", fg: "var(--color-danger)" }));
  const groups = r.items.map((i) => ({
    t: `${EFFECT_WORDS[i.effect]} · ${i.effect === "kept" && i.count === 0 ? "" : `${i.count.toLocaleString("en-IN")} `}${i.label}${i.examples?.length ? `\n${i.examples.join(" · ")}` : ""}${i.note ? `\n${i.note}` : ""}`,
  }));
  return [...blockers, ...groups];
}

/**
 * Reads the report and opens the modal. `run` performs the act with the
 * confirmation; whatever it refuses is shown in the modal, which stays open.
 */
export async function openImpactModal(
  modal: (m: ModalSpec | null) => void,
  kind: string,
  id: string,
  run: (c: ImpactConfirmation) => Promise<Result<unknown>>,
  onDone: (message?: string) => void,
): Promise<string | null> {
  const res = await previewImpact(kind, id);
  if (!res.ok) return res.error;
  const r = res.data;
  const blocked = r.blockers.length > 0;
  modal({
    title: `${r.verb} ${r.title}?`,
    vault: true,
    danger: true,
    notes: notesOf(r),
    fields: blocked ? [] : [{ k: "typed", l: `Type “${r.confirmWord}” to confirm`, req: true }],
    okL: blocked ? undefined : r.verb,
    cancel: blocked ? "Close" : "Cancel",
    done: async (v) => {
      const out = await run({ typed: v.typed ?? "", fingerprint: r.fingerprint });
      if (!out.ok) return out.code === "conflict" ? `${out.error} Close and open it again.` : out.error;
      onDone(out.message);
    },
  });
  return null;
}
