import type { Metadata } from "next";
/* Before globals.css, which names the faces through the variables this
   declares. Every font file is in the repository (src/app/fonts/) — a build
   no longer reaches Google. */
import "./fonts/fonts.css";
import "./globals.css";
import { StaffChrome } from "@/components/shell/staff-chrome";

export const metadata: Metadata = {
  title: "MahekOne - CRM",
  description:
    "Mahek Marketing India's connected workspace. CRM for the telecaller team.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // The fonts are MahekOne's own files now, not a stylesheet from Google that
    // held every page until it arrived — see ./fonts.ts.
    <html lang="en">
      <body>
        {children}
        {/* The bell and the stale-tab guard — never on a customer's or vendor's link. */}
        <StaffChrome />
      </body>
    </html>
  );
}
