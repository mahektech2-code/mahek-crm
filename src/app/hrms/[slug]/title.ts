import { hrmsScreenBySlug } from "@/lib/hrms/registry";

/** "Leave & holidays · To decide — HRMS — MahekOne", the house pattern for a tab title. */
export function hrmsModuleTitle(slug: string, view?: string): string {
  const s = hrmsScreenBySlug(slug);
  if (!s) return "HRMS — MahekOne";
  const tab = s.views?.find((v) => v.key === view);
  return `${tab ? `${s.label} · ${tab.label}` : s.label} — HRMS — MahekOne`;
}
