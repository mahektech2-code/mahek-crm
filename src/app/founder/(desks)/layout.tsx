import { redirect } from "next/navigation";
import { founderAccess } from "@/lib/command-centre/access";
import { shellChrome } from "@/lib/command-centre/shell";
import { DeskFrame } from "./desk-shell";

/**
 * The founder's two working DESKS — price lists and WhatsApp — drawn inside the
 * Command Centre's own header and sidebar, read from the same `shellChrome` the
 * page reads, so a count on the sidebar is the same count on both. The gate
 * itself is the parent layout's; each desk checks its own module below.
 */
export default async function FounderDesksLayout({ children }: { children: React.ReactNode }) {
  const access = await founderAccess();
  if (!access.allowed.length) redirect("/apps");
  const chrome = await shellChrome(access);
  return (
    <DeskFrame chrome={chrome} allowed={access.allowed}>
      {children}
    </DeskFrame>
  );
}
