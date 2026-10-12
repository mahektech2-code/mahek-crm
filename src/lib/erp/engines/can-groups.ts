/* ---------------------------------------------------------------------------
 * CAN GROUPS BY NAME: which cans are the same can in different sizes.
 *
 * "Packing Material 1 liter Mahek Yellow", "Mahek Yellow 5 Ltr" and
 * "packing material 20 LITER mahek yellow" are one print — what somebody on the
 * floor recognises — in three sizes. So a can's FAMILY is its name with the
 * size and the words every can carries ("packing", "material", "can", "tin")
 * taken out, and cans whose families match, or nearly match, are one group.
 *
 * PURE: it is handed the cans and the groups that already exist, and says
 * which new groups to make and which cans to put where. It never moves a can
 * somebody already grouped — the caller hands it only the ungrouped ones — and
 * a can whose name is nothing BUT a size and those words ("1 L Tin Can") has no
 * family to read, so it is left for a person rather than guessed at.
 * ------------------------------------------------------------------------- */

/** Words every can name carries, which say nothing about which can it is. */
const NOISE = new Set([
  "packing", "pack", "material", "materials", "can", "cans", "tin", "tins", "empty", "container", "for", "of", "the", "and", "with", "-",
]);

/** Units a size is written in, as a word of their own or stuck to the number ("5ltr"). */
const UNIT = "(?:l|lt|ltr|ltrs|liter|liters|litre|litres|ml|kg|kgs|gm|g)";
const SIZE_STUCK = new RegExp(`^\\d+(?:[.,]\\d+)?${UNIT}$`);
const SIZE_UNIT = new RegExp(`^${UNIT}$`);
const NUMBER = /^\d+(?:[.,]\d+)?$/;

/** Lower case, punctuation to spaces, the size and the noise words gone. */
export function familyWords(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/\(?\s*\d+\s*cans?\s*\/\s*box\s*\)?/g, " ")
    .replace(/\(\s*loose\s*\)/g, " ")
    .replace(/[()[\]{}/\\,;:_+*&"'`]/g, " ")
    .replace(/(\d)\s*[x×]\s*(\d)/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  return words.filter((w) => !NOISE.has(w) && !SIZE_STUCK.test(w) && !SIZE_UNIT.test(w) && !NUMBER.test(w));
}

/** The family as a key: its words, de-duplicated, in order. Empty: nothing to read. */
export function familyKey(name: string): string {
  return [...new Set(familyWords(name))].join(" ");
}

/** "mahek yellow" → "Mahek Yellow". */
export function familyLabel(key: string): string {
  return key
    .split(" ")
    .map((w) => (w.length <= 2 && /^[a-z]+$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Two families are one when they share most of their words (Dice ≥ 0.8), or one is the other plus a word. */
export function sameFamily(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  if (common === 0) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  if (common === small.size && big.size - small.size <= 1 && small.size >= 2) return true;
  return (2 * common) / (A.size + B.size) >= 0.8;
}

export type CanForGrouping = { id: string; name: string };
export type ExistingGroup = { id: string; name: string; memberNames: string[] };

export type GroupPlan = {
  /** Groups to create, each with the cans that go in it. */
  create: { name: string; memberIds: string[] }[];
  /** Cans that join a group already there. */
  join: { groupId: string; groupName: string; memberIds: string[] }[];
  /** Cans whose name carries no family, or whose family nobody else shares. */
  left: { id: string; name: string; why: "no_family" | "alone" }[];
};

/**
 * Plans the groups for `cans` (the ungrouped ones). A can joins an existing
 * group where its family matches that group's name or any of its members';
 * otherwise cans of one family make a new group, named after the family — and
 * only where there are at least two of them, because a group of one is a name
 * with nothing to recognise it by.
 */
export function planCanGroups(cans: CanForGrouping[], existing: ExistingGroup[]): GroupPlan {
  const plan: GroupPlan = { create: [], join: [], left: [] };
  const groupKeys = existing.map((g) => ({ g, keys: [familyKey(g.name), ...g.memberNames.map(familyKey)].filter(Boolean) }));
  const clusters: { key: string; ids: string[] }[] = [];
  const joins = new Map<string, { groupId: string; groupName: string; memberIds: string[] }>();
  for (const c of [...cans].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = familyKey(c.name);
    if (!key) {
      plan.left.push({ id: c.id, name: c.name, why: "no_family" });
      continue;
    }
    const home = groupKeys.find((x) => x.keys.some((k) => sameFamily(k, key)));
    if (home) {
      const j = joins.get(home.g.id) ?? { groupId: home.g.id, groupName: home.g.name, memberIds: [] };
      j.memberIds.push(c.id);
      joins.set(home.g.id, j);
      continue;
    }
    const cl = clusters.find((x) => sameFamily(x.key, key));
    if (cl) cl.ids.push(c.id);
    else clusters.push({ key, ids: [c.id] });
  }
  plan.join = [...joins.values()];
  const taken = new Set(existing.map((g) => g.name.toLowerCase()));
  for (const cl of clusters) {
    if (cl.ids.length < 2) {
      const c = cans.find((x) => x.id === cl.ids[0])!;
      plan.left.push({ id: c.id, name: c.name, why: "alone" });
      continue;
    }
    let name = familyLabel(cl.key);
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${familyLabel(cl.key)} ${n}`;
    taken.add(name.toLowerCase());
    plan.create.push({ name, memberIds: cl.ids });
  }
  return plan;
}

/** How many photos a can, and a group, may carry. */
export const MAX_CAN_PHOTOS = 3;
export const MAX_GROUP_PHOTOS = 3;
