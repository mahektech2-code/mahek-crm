import { ProtoListPage } from "../list-view";

export const metadata = { title: "Sales Manager leads — CRM — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ProtoListPage viewKey="distributors" searchParams={await searchParams} />;
}
