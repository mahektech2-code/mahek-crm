/**
 * The pill colour for a score, shared by the server-rendered table and the
 * client modal — so it lives outside both, in a file with no directive.
 */
export function ratingTone(bp: number): "success" | "brand" | "warn" | "danger" {
  const score = bp / 100;
  if (score >= 90) return "success";
  if (score >= 80) return "brand";
  if (score >= 60) return "warn";
  return "danger";
}
