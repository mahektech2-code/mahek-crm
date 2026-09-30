import { hrmsScreenBySlug } from "@/lib/hrms/registry";

/** "Leave requests — HRMS — MahekOne", the house pattern for a tab title. */
export function hrmsModuleTitle(slug: string): string {
  const s = hrmsScreenBySlug(slug);
  return s ? `${s.label} — HRMS — MahekOne` : "HRMS — MahekOne";
}
