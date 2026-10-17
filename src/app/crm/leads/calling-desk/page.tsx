/*
 * A ROUTE, and the screen is somewhere else.
 *
 * The Lead Management workspace is mounted by both the Manager Console and the
 * CRM from one set of files — see `lib/lead-workspace.ts`. The calling desk is
 * the CRM's alone, so it has a route here and none under `/sales`.
 */
import { Body } from "@/components/leads/pages/leads-calling-desk";

export const metadata = { title: "Calling desk — CRM — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <Body workspace="crm" searchParams={searchParams} />;
}
