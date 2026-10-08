import { redirect } from "next/navigation";

/**
 * Visits is a tab of Journeys & visits now — the plan and the visits it
 * produced are one story. This address lives on in bookmarks and in links
 * other people were sent, so it forwards rather than 404s, carrying the day
 * and the filter it was asked for.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; show?: string }>;
}) {
  const params = await searchParams;
  const q = new URLSearchParams({ tab: "visits" });
  if (params.day) q.set("day", params.day);
  if (params.show) q.set("show", params.show);
  redirect(`/sales/journeys?${q.toString()}`);
}
