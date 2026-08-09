import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      /*
       * The Accounts app was called Orders, and lived at /orders, until it grew
       * past the name — it now holds approvals, receipts, the bill ledger,
       * credit notes, on-account balances, the sheet import and the audit log.
       *
       * The slug moved with it. These keep every bookmark, every link in
       * somebody's email and every screenshot in a WhatsApp group working, and
       * they carry the rest of the path so a link to a particular screen still
       * lands on that screen rather than dumping the reader on the home page.
       *
       * Permanent, because the old path is not coming back.
       */
      { source: "/orders", destination: "/accounts", permanent: true },
      { source: "/orders/:path*", destination: "/accounts/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
