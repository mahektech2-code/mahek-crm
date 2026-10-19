import { partyNameKey } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * RENAMING A PARTY, WITHOUT LOSING THE SHEETS.
 *
 * The order sheet, the Sales Party tab and the Taken Order tab all name a
 * party by TEXT. A rename in the CRM or the ERP used to do two kinds of damage
 * at once: the order projection wrote the sheet's spelling back over the new
 * name within the half hour, and every name-matched link (the party master's
 * phone and seats, where an order was delivered, the back office handover)
 * silently stopped finding the record.
 *
 * So the first rename keeps the name the sheets use in `customers.sheet_name`,
 * and every sheet matcher asks for either. Renaming back to the sheet's own
 * spelling clears it again, because then there is nothing left to remember.
 * Pure, so the ERP form, the CRM form and the tests read one rule.
 * ------------------------------------------------------------------------- */

export type NamedParty = { name: string; sheetName: string | null };

/** How a name is compared: case and spacing are not a different party. */
export const foldName = (name: string) => partyNameKey(name);

/**
 * The columns a rename writes, or null when the name is not moving.
 *
 * The sheet's name is kept on the FIRST rename, even one that only changes
 * case or spacing: the order projection writes the sheet's spelling back over
 * any name that differs from it, so a corrected capital is a rename too. Set
 * back to the sheet's exact spelling, there is nothing left to remember.
 */
export function renameValues(before: NamedParty, next: string): NamedParty | null {
  const name = next.trim().replace(/\s+/g, " ");
  if (!name || name === before.name) return null;
  const sheetName = before.sheetName ?? before.name;
  return { name, sheetName: sheetName === name ? null : sheetName };
}

/** Every folded name a sheet may use for this party: its own, and the one the sheets knew it by. */
export function sheetKeys(p: NamedParty): string[] {
  const keys = [foldName(p.name)];
  if (p.sheetName) {
    const k = foldName(p.sheetName);
    if (k !== keys[0]) keys.push(k);
  }
  return keys;
}
