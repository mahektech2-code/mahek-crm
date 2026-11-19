import "server-only";
import { requireUser } from "@/lib/auth";
import { NotAllowedHere, requireNoteIn } from "./access";
import { deleteNote, editNote, ownNote, refusal } from "./provider";
import type { Result } from "./types";

/* ---------------------------------------------------------------------------
 * ONE'S OWN NOTE, corrected or taken off the timeline.
 *
 * Somebody else's note is refused as "not yours" — the same answer as a note
 * that does not exist — and the author still needs to be able to act where
 * the note sits, as adding it did (`requireNoteIn`). Neither touches the
 * original audit row: see `editNote` / `deleteNote` in `provider.ts`.
 * ------------------------------------------------------------------------- */

async function ownNoteOrRefuse(noteId: string) {
  const user = await requireUser();
  const own = await ownNote(user.id, noteId);
  if (!own) throw new NotAllowedHere("That note is not yours, or it has been deleted.");
  await requireNoteIn(own.kind);
  return user;
}

export async function editOwnNote(noteId: string, note: string): Promise<Result> {
  try {
    const text = note.trim();
    if (!text) return { ok: false, error: "Write the note first", fieldErrors: { n: "Note is needed" } };
    if (text.length > 4000) return { ok: false, error: "Keep the note under 4,000 characters", fieldErrors: { n: "Too long" } };
    const user = await ownNoteOrRefuse(noteId);
    await editNote(user.id, noteId, text);
    return { ok: true, message: "Note updated" };
  } catch (e) {
    return refusal(e);
  }
}

export async function deleteOwnNote(noteId: string): Promise<Result> {
  try {
    const user = await ownNoteOrRefuse(noteId);
    await deleteNote(user.id, noteId);
    return { ok: true, message: "Note deleted" };
  } catch (e) {
    return refusal(e);
  }
}
