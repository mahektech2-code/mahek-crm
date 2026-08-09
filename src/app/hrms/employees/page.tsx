import { employeeMaster } from "@/lib/services/employee-service";
import { EmployeeScreen } from "./employee-screen";

export const metadata = { title: "All Employees — MahekOne HRMS" };

/**
 * Always read fresh.
 *
 * The point of this screen is that a row added to the sheet a minute ago is on
 * it. A cached render would show the state of the last build to the one person
 * most likely to be checking whether the import worked.
 */
export const dynamic = "force-dynamic";

export default async function Page() {
  const master = await employeeMaster();
  return <EmployeeScreen master={master} />;
}
