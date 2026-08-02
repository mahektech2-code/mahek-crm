import { requireUser } from "@/lib/auth";
import { ComponentsScreen } from "./components-screen";

export const metadata = { title: "Component library — MahekOne" };

export default async function ComponentsPage() {
  await requireUser();
  return <ComponentsScreen />;
}
