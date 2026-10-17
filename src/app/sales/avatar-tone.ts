/**
 * A soft colour for somebody's initials, the same every time for one name.
 *
 * Forty grey circles in a column read as one block; a steady colour per person
 * is what lets a manager find "the green MP" again after scrolling. Taken from
 * the name rather than the id so it is also the same on every screen that only
 * has the name.
 */
const TONES = [
  "bg-[#EEE9FF] text-[#5223E0]",
  "bg-[#E6F4EC] text-[#1D7A45]",
  "bg-[#E8F0FC] text-[#2B5CBF]",
  "bg-[#FDF1E2] text-[#9A5B00]",
  "bg-[#FCE9EF] text-[#B0285A]",
  "bg-[#E4F5F6] text-[#137A80]",
  "bg-[#F1EDE6] text-[#6B5A3E]",
];

export function avatarTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}
