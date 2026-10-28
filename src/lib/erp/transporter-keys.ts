/* ---------------------------------------------------------------------------
 * The impact-report ids for renaming and merging a transporter — PURE and
 * client-safe, because the dialog that opens the report and the action that
 * checks it have to spell the same id, or the fingerprint never matches.
 *
 * A rename's id carries the NEW name as well as the row: the report says what
 * the records will be renamed to, and a name edited after the report opened is
 * a different rename that must be confirmed again.
 * ------------------------------------------------------------------------- */

const SEP = "|";

export function transporterRenameKey(id: string, newName: string): string {
  return `${id}${SEP}${newName.trim().replace(/\s+/g, " ")}`;
}

export function readTransporterRenameKey(key: string): { id: string; name: string } {
  const at = key.indexOf(SEP);
  return at < 0 ? { id: key, name: "" } : { id: key.slice(0, at), name: key.slice(at + 1) };
}

export function transporterMergeKey(fromId: string, intoId: string): string {
  return `${fromId}>${intoId}`;
}

export function readTransporterMergeKey(key: string): { fromId: string; intoId: string } {
  const [fromId = "", intoId = ""] = key.split(">");
  return { fromId, intoId };
}
