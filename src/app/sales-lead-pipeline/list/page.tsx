import { Suspense } from "react";
import { ListScreen } from "@/components/sales-lead-pipeline/list-screen";

export const metadata = { title: "All Leads — Sales Manager — MahekOne" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ListScreen />
    </Suspense>
  );
}
