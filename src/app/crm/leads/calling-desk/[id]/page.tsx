/*
 * A ROUTE, and the screen is somewhere else.
 *
 * The Telecaller's own lead record. It is beside `/crm/leads/[id]`, which the
 * salesman and the sales manager use and which this does not replace.
 */
import { Body } from "@/components/leads/pages/leads-calling-desk-record";

export const metadata = { title: "Lead — Telecaller — CRM — MahekOne" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Body workspace="crm" params={params} />;
}
