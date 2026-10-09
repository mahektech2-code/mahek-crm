import type { NextConfig } from "next";
import createMDX from "@next/mdx";
import { ADMIN_REDIRECTS } from "./src/lib/admin-redirects";
import { HRMS_RETIRED_SLUGS, hrmsLink } from "./src/lib/hrms/registry";

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

  /**
   * NOTHING HERE OPTIMISES AN IMAGE, so the optimiser does not ship.
   *
   * `next/image` is imported nowhere in this app, and that is deliberate
   * rather than an oversight: the only picture any screen renders is an
   * attachment, served from `/api/attachments/[id]`, which is authenticated,
   * scope-checked and has no width or height until it is fetched — so
   * `selfies.tsx` uses a plain `<img>` with the lint rule disabled and a
   * comment saying why.
   *
   * Next still bundles `sharp` for the optimiser regardless, and the standalone
   * trace carries it into the runtime image: 16.6 MB of native binaries, a
   * QUARTER of the 62 MB application layer, to resize pictures that are never
   * asked for. The container registry this pushes to holds 500 MB in total and
   * keeps a few tags for rolling back, so a quarter of the app layer is a real
   * constraint rather than housekeeping — deploys have already failed on that
   * quota.
   *
   * `unoptimized` does not disable images; it disables the RESIZING ENDPOINT,
   * which nothing calls. If somebody adds `next/image` later this must be
   * reconsidered rather than worked around — the pictures would still render,
   * simply at their natural size, which is a slower page nobody would notice
   * was slower.
   *
   * IT DOES NOT, ON ITS OWN, STOP SHARP SHIPPING. That was measured rather
   * than assumed: the build was run with and without this, and with
   * `outputFileTracingExcludes` aimed at it, and `standalone/node_modules/@img`
   * survived all three — Next copies the optimiser's binaries into standalone
   * outside the file trace. The Dockerfile removes them in the runtime stage,
   * and the comment there explains why that is safe. The two belong together:
   * this setting is what makes the removal correct rather than a gamble.
   */
  images: { unoptimized: true },


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

  experimental: {
    /*
     * How much of a request body survives `src/proxy.ts`. Next buffers a
     * proxied body so the proxy and the route can both read it, and past this
     * it keeps the first N bytes and says so only in the server log — the
     * route is handed a truncated upload and no error. The default is 10 MB,
     * which is how a 12 MB price list read as "the file did not arrive whole"
     * three times running. It has to sit ABOVE `PUBLISH_MAX_MB` in
     * `lib/publish-limits.ts` with room for the multipart framing, so that the
     * route, not the proxy, is what refuses a file that is too big — and says
     * the limit in words. `publish-limits.test.ts` holds the two together.
     */
    proxyClientMaxBodySize: "32mb",
  },

  /*
   * The same sha, inlined into BOTH the server and the browser bundle, for
   * the factory phone: a station phone keeps a page open for days, and it
   * compares its own build with the one the server answers in, so it can
   * reload itself once its queue is empty — never in the middle of a job.
   */
  env: { FACTORY_BUILD: process.env.NEXT_DEPLOYMENT_ID ?? "dev" },

  /*
   * Set by the app rather than by Caddy, because the Caddyfile is copied to
   * the droplet by hand and a deploy never touches it — a header written
   * there would reach production only when somebody remembered to.
   *
   * HSTS: HTTPS, always, for a year. Caddy already redirects http to https;
   * this is what stops the browser asking over http at all, where the first
   * request on café Wi-Fi is one an attacker can answer.
   *
   * Not inside somebody else's page: without these any site could load the
   * Admin Console in an invisible frame over a button of its own and have a
   * signed-in administrator press Save on the Access screen without seeing
   * it. SAMEORIGIN rather than DENY because the price-list editor previews
   * its own print page in a frame. The first is the old spelling, the second
   * the current one.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },

  /* Android asks for this exact path to trust the Factory app's APK; the
     answer is published by the APK's own release (see api/assetlinks). */
  async rewrites() {
    return [{ source: "/.well-known/assetlinks.json", destination: "/api/assetlinks" }];
  },
  async redirects() {
    return [
      /*
       * The Admin Console's old addresses — one page that read its screen out
       * of the path — and where each screen lives now. See the file itself.
       */
      ...ADMIN_REDIRECTS,

      /*
       * The Reports app is retired. A bookmark lands on the launcher rather
       * than a 404 — not on /founder, which is granted separately and would
       * only refuse most of the people holding an old Reports link.
       */
      { source: "/reports", destination: "/apps", permanent: false },
      { source: "/reports/:path*", destination: "/apps", permanent: false },
      /* Removed from the Sales Dashboard on Mahek's instruction: prices are the
         price desk's and pay is HRMS's. A bookmark lands on the dashboard
         rather than on a 404 that reads as something broken. */
      { source: "/sales/catalogue", destination: "/sales", permanent: false },
      { source: "/sales/price-lists", destination: "/sales", permanent: false },
      { source: "/sales/price-lists/:path*", destination: "/sales", permanent: false },
      { source: "/sales/salary", destination: "/sales", permanent: false },

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
      /*
       * The Founder Dashboard's four read-only tabs became sections of the
       * Founder Command Centre, addressed `/founder?s=<section>`. Their old
       * paths keep working for every bookmark that still names them.
       */
      { source: "/founder/team", destination: "/founder?s=team", permanent: true },
      { source: "/founder/money", destination: "/founder?s=money", permanent: true },
      { source: "/founder/people", destination: "/founder?s=people", permanent: true },
      { source: "/founder/crm", destination: "/founder?s=sales", permanent: true },

      /*
       * The ERP's lists that were each their own screen in Mahek Plus are tabs
       * of one screen now — the four stock stages and their logs, the re-order
       * lists, Pending LR and Track LR, the petty-cash credits. A bookmark to
       * the old screen lands on its tab.
       */
      { source: "/erp/rm-stock", destination: "/erp/stock", permanent: true },
      { source: "/erp/rm-log", destination: "/erp/stock?view=rmLog", permanent: true },
      { source: "/erp/sfg-stock", destination: "/erp/stock?view=sfgStock", permanent: true },
      { source: "/erp/sfg-log", destination: "/erp/stock?view=sfgLog", permanent: true },
      { source: "/erp/fg-stock", destination: "/erp/stock?view=fgStock", permanent: true },
      { source: "/erp/fg-log", destination: "/erp/stock?view=fgLog", permanent: true },
      { source: "/erp/pack-stock", destination: "/erp/stock?view=packStock", permanent: true },
      { source: "/erp/pack-log", destination: "/erp/stock?view=packLog", permanent: true },
      { source: "/erp/reorder-rm", destination: "/erp/rm-levels", permanent: true },
      { source: "/erp/reorder-fg", destination: "/erp/fg-levels", permanent: true },
      { source: "/erp/pending-lr", destination: "/erp/transport", permanent: true },
      { source: "/erp/track-lr", destination: "/erp/transport?view=trackLr", permanent: true },
      { source: "/erp/paid-freight", destination: "/erp/transport?view=paidFreight", permanent: true },
      { source: "/erp/credits", destination: "/erp/expenses?view=credits", permanent: true },
      { source: "/erp/powers", destination: "/admin/people", permanent: true },
      { source: "/erp/employees", destination: "/hrms/people", permanent: true },
      /* The HRMS's 41 screens became 14 (lib/hrms/registry.ts): each old
         screen is a tab now, reached at its screen's URL with ?view=. */
      ...Object.entries(HRMS_RETIRED_SLUGS).map(([slug, key]) => ({ source: `/hrms/${slug}`, destination: hrmsLink(key), permanent: true })),
      /* The sales-order lists and Order details are tabs of one Orders screen;
         order follow-up is the CRM's buying cycle now, so its old screens land
         on the ERP's home rather than on a 404. */
      { source: "/erp/pending-orders", destination: "/erp/orders", permanent: true },
      { source: "/erp/ready-orders", destination: "/erp/orders?view=readyOrders", permanent: true },
      { source: "/erp/order-details", destination: "/erp/orders?view=orderDetails", permanent: true },
      { source: "/erp/batch-codes", destination: "/erp/orders?view=batchCodes", permanent: true },
      { source: "/erp/labels", destination: "/erp/orders?view=labels", permanent: true },
      { source: "/erp/order-inbox", destination: "/erp/orders?view=orderInbox", permanent: true },
      /* Complaints and credit notes are one screen on the CRM's complaints;
         Pending CN is gone (the margin reads the credit note where it is). */
      { source: "/erp/issue-cn", destination: "/erp/requests?view=issueCn", permanent: true },
      { source: "/erp/complaints", destination: "/erp/requests?view=complaints", permanent: true },
      { source: "/erp/pending-cn", destination: "/erp/requests?view=issueCn", permanent: true },
      /* Inward, the register and drum labels are tabs of one Purchases screen. */
      { source: "/erp/inward", destination: "/erp/register", permanent: true },
      { source: "/erp/barcode", destination: "/erp/register?view=barcode", permanent: true },
      { source: "/erp/followup", destination: "/erp", permanent: true },
      { source: "/erp/pivot", destination: "/erp", permanent: true },

      { source: "/orders", destination: "/accounts", permanent: true },
      { source: "/orders/:path*", destination: "/accounts/:path*", permanent: true },

      /*
       * The same lesson again, three screens at once.
       *
       * The funnel's nine screens all sat directly under /sales/leads while it
       * was one module. Lead Management is ten now, and three moved into the
       * module whose job they actually are: the verification queue is
       * Qualification's, the nurture schedule and the list of leads with
       * nothing scheduled are Next actions'.
       *
       * A route is a bookmark, and `no-next-action` is the one most likely to
       * be linked from a message rather than reached from a sidebar — it is
       * §24 made visible, so it is what a manager sends somebody.
       */
      {
        source: "/sales/leads/verification",
        destination: "/sales/leads/qualify/verification",
        permanent: true,
      },
      {
        source: "/sales/leads/nurture",
        destination: "/sales/leads/actions/nurture",
        permanent: true,
      },
      {
        source: "/sales/leads/no-next-action",
        destination: "/sales/leads/actions/none",
        permanent: true,
      },

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

/*
 * THE DOCUMENTATION APP'S PAGES ARE MDX, compiled at build time.
 *
 * They are imported by `src/docs/content.ts`, never routed as files — so
 * `pageExtensions` is untouched and the access gate in `src/app/docs/layout.tsx`
 * stands in front of every one of them. Plugins are named as STRINGS because
 * Turbopack cannot be handed a JavaScript function; their options have to be
 * plain data for the same reason. Shiki colours the code fences here, at
 * build, so no highlighter ships in the runtime image.
 */
const withMDX = createMDX({
  extension: /\.mdx$/,
  options: {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: ["rehype-slug", ["@shikijs/rehype", { theme: "github-light", addLanguageClass: true }]],
  },
});

export default withMDX(nextConfig);
