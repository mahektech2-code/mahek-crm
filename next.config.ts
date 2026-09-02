import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Self-hosted, so Next has to emit a server rather than assume a platform
   * will supply one. `standalone` traces the files the server actually imports
   * and writes them beside it, node_modules pruned to what is reachable — a
   * ~200 MB image instead of a ~1 GB one, which is the difference between
   * fitting in the free container registry and not.
   *
   * Harmless anywhere else: a platform that provides its own server ignores it.
   */
  output: "standalone",

  /*
   * Where the traced tree is rooted, stated rather than inferred.
   *
   * Next walks UP from the project looking for a lockfile to decide the
   * workspace root, and a stray `package-lock.json` anywhere above — a home
   * directory, a parent folder holding several projects — silently hoists it.
   * The build still succeeds; it just writes `server.js` several directories
   * deep inside `.next/standalone`, and the Dockerfile's COPY then lands an
   * empty tree that fails at container start rather than at build.
   *
   * It happens to be correct inside Docker, where the repository is the whole
   * build context. Depending on that is depending on an accident.
   */
  outputFileTracingRoot: process.cwd(),

  /*
   * Version-skew protection: without it, a browser tab left open across a
   * deploy submits a form whose Server Action id belonged to the OLD build,
   * and Next answers with a raw "Server Action ... was not found on the
   * server" toast rather than anything a telecaller mid-call can make sense
   * of. With a deployment id set, Next compares the client's against the
   * server's on every navigation and forces a full reload on a mismatch —
   * so the tab catches up before it can hit the error at all.
   *
   * Set from `NEXT_DEPLOYMENT_ID`, which the Dockerfile bakes in at build
   * time as the same commit sha the image is tagged with — see the ARG
   * there. Undefined in local dev, where there is no deploy to skew against
   * and the feature is simply off.
   */
  deploymentId: process.env.NEXT_DEPLOYMENT_ID,

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

      /*
       * The same lesson at a smaller scale. This screen shipped at
       * /crm/deactivations and answers requests in BOTH directions — close an
       * account, reopen a closed one — so the name described half of it and the
       * route moved to /crm/status-requests.
       *
       * The redirect is not hypothetical. Every deactivation and reactivation
       * request already raised sent a notification to every manager carrying
       * `/crm/deactivations` as its href, and those rows are still in the
       * database. Without this, clicking the bell on any of them lands on a 404
       * — which reads as "the request is gone" rather than "the page moved".
       *
       * The permission key did NOT move with it: `app_module_access` still
       * stores `crm.deactivations`, because a key is a join and renaming one
       * silently revokes the screen from everybody who holds it.
       */
      {
        source: "/crm/deactivations",
        destination: "/crm/status-requests",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
