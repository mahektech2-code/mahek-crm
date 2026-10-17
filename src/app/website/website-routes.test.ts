import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_MODULES, moduleAllowed } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * The Website app's route guards and server surface.
 *
 * What a person may open is the module grant, and the grant is only worth
 * anything if every route checks it: the sidebar hiding a link is a courtesy.
 * The integration suite (`website-cms.test.ts`) proves what the server REFUSES;
 * this file runs on every commit and fails the day somebody adds a screen
 * without a guard, an action that skips the permission layer, or a public route
 * that forgets the secret.
 *
 * File-reading rather than rendering, for the reason `layout-rules.test.ts` is:
 * the guards are server components that redirect, and nothing here has a request
 * to run them in. The 12-by-12 runtime check is the browser run in the PR.
 * ------------------------------------------------------------------------- */

const ROOT = process.cwd();
const DIR = join(ROOT, "src", "app", "website");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/**
 * The review workflow's screens are not modules — the right to open them is the
 * review right or having work to do, not a tick on a screen — so each carries the
 * guard of the right it needs. A new folder here must be added with its guard.
 */
const WORKFLOW: Record<string, string> = {
  "my-work": "requireWebsiteWorkflow",
  review: "requireWebsiteReview",
  assignments: "requireWebsiteReview",
};

const websiteModules = APP_MODULES.filter((m) => m.app === "website");
const screens = websiteModules.filter((m) => !m.writeOf);
const slugOf = (key: string) => key.replace(/^website\./, "");

describe("the Website module registry", () => {
  it("has the 12 screens, dashboard first, and two separate rights: to publish and to review", () => {
    assert.deepEqual(
      screens.map((m) => slugOf(m.key)),
      ["dashboard", "products", "industries", "pages", "gallery", "media", "careers", "testimonials", "milestones", "navigation", "seo", "settings"],
    );
    assert.deepEqual(websiteModules.filter((m) => m.writeOf).map((m) => m.key), ["website.publish", "website.review"]);
  });
  it("every screen points at a route that exists", () => {
    for (const m of screens) {
      const slug = slugOf(m.key);
      const file = slug === "dashboard" ? "page.tsx" : join(slug, "page.tsx");
      assert.ok(existsSync(join(DIR, file)), `${m.key} → ${m.href} has no ${file}`);
      assert.equal(m.href, slug === "dashboard" ? "/website" : `/website/${slug}`, m.key);
    }
  });
  it("the sidebar offers exactly the registered screens, and the review workflow's three beside them", () => {
    const shell = read("src", "app", "website", "website-shell.tsx");
    const split = shell.indexOf("const WORK_NAV");
    assert.ok(split > 0, "the workflow screens are their own list");
    const hrefsIn = (src: string) => [...src.matchAll(/href: "(\/website[^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual(hrefsIn(shell.slice(0, split)).sort(), screens.map((m) => m.href).sort());
    assert.deepEqual(hrefsIn(shell.slice(split)).sort(), ["/website/assignments", "/website/my-work", "/website/review"]);
  });
});

describe("every Website route enforces its own module grant", () => {
  for (const m of screens) {
    const slug = slugOf(m.key);
    it(`${m.key} is guarded on the server`, () => {
      const file = slug === "dashboard" ? "page.tsx" : join(slug, "layout.tsx");
      assert.ok(existsSync(join(DIR, file)), `${m.key} has no ${file}`);
      const src = readFileSync(join(DIR, file), "utf8");
      assert.match(src, new RegExp(`await requireWebsiteModule\\("${slug}"\\)`), `${file} must await requireWebsiteModule("${slug}") — a hidden link is not a guard`);
    });
  }
  it("the guard asks for the module key of the slug it is given", () => {
    assert.match(read("src", "app", "website", "require-module.ts"), /requireModule\(user\.id, `website\.\$\{slug\}`\)/);
  });
  it("no folder is left without a layout guard: a registered module, or one of the review workflow's own", () => {
    const folders = readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "cms-ui")
      .map((d) => d.name);
    for (const f of folders) {
      assert.ok(existsSync(join(DIR, f, "layout.tsx")), `src/app/website/${f} has no layout.tsx guard`);
      assert.ok(screens.some((m) => slugOf(m.key) === f) || f in WORKFLOW, `${f} is neither a registered Website module nor a review screen`);
    }
  });
  it("the shared redirect never sends somebody to a write right as if it were a screen", () => {
    assert.match(read("src", "lib", "access.ts"), /allowed\.find\(\(m\) => !m\.writeOf\)/);
  });
});

describe("the review workflow's routes enforce their own right", () => {
  for (const [folder, guard] of Object.entries(WORKFLOW)) {
    it(`/website/${folder} is guarded on the server by ${guard}`, () => {
      const src = readFileSync(join(DIR, folder, "layout.tsx"), "utf8");
      assert.match(src, new RegExp(`await ${guard}\\(\\)`), `${folder}/layout.tsx must await ${guard}() — a hidden link is not a guard`);
      assert.ok(existsSync(join(DIR, folder, "page.tsx")), `${folder} has no page`);
    });
  }
  it("a request's own pages sit under those layouts, so they inherit the guard", () => {
    assert.ok(existsSync(join(DIR, "my-work", "[id]", "page.tsx")));
    assert.ok(existsSync(join(DIR, "review", "[id]", "page.tsx")));
    assert.equal(existsSync(join(DIR, "my-work", "[id]", "layout.tsx")), false, "no second layout that could weaken the first");
    assert.equal(existsSync(join(DIR, "review", "[id]", "layout.tsx")), false);
  });
  it("the guards ask for the right they name — and for nothing the app grant implies", () => {
    const src = read("src", "app", "website", "require-module.ts");
    const body = (name: string) => src.slice(src.indexOf(`export async function ${name}(`)).split(/\nexport async function /)[0];
    assert.match(body("requireWebsiteReview"), /holdsReview\(user\.id\)/);
    assert.match(body("requireWebsiteWorkflow"), /canEditAny\(user\.id\)/);
    assert.match(body("requireWebsiteWorkflow"), /holdsReview\(user\.id\)/);
    assert.match(body("requireWebsiteModule"), /requireModule\(user\.id, `website\.\$\{slug\}`\)/);
  });
  it("the Website header carries the bell, because that is where every review message is addressed", () => {
    assert.match(read("src", "app", "website", "website-shell.tsx"), /<NotificationBell \/>/);
  });
  it("the sidebar draws the review links from flags the layout worked out, not from the module list", () => {
    const layout = read("src", "app", "website", "layout.tsx");
    assert.match(layout, /holdsReview\(user\.id\)/);
    assert.match(layout, /work=\{work\}/);
  });
});

describe("what the review screens may call", () => {
  const files = ["review-ui.tsx", "my-work-screen.tsx", "review-queue.tsx", "assign-screen.tsx", "request-page.tsx"];
  const ui = (f: string) => read("src", "app", "website", "cms-ui", f);

  it("they go through server actions — never the database, the service or the commands", () => {
    for (const f of files) {
      const src = ui(f);
      // A type-only import is erased at build time and reaches nothing; a value import would.
      const imports = src.split(/\r?\n/).filter((l) => /^import /.test(l) && !/^import type /.test(l));
      assert.ok(!imports.some((l) => /@\/db/.test(l)), `${f} imports the database`);
      assert.ok(!imports.some((l) => /website-cms\/(commands|review-service|service|media-service|review-queries)"/.test(l)), `${f} reaches past the actions`);
    }
  });

  it("an employee's only publish button is 'Publish approved changes', on an approved, unexpired request", () => {
    for (const f of files) {
      assert.doesNotMatch(
        ui(f),
        /publishItemsAction|unpublishItemAction|archiveItemAction|restoreItemAction|publishPendingAction|refreshLiveSiteAction|importContentAction/,
        `${f} offers a publish the employee must not have`,
      );
    }
    const src = ui("review-ui.tsx");
    assert.equal((src.match(/^\s+Publish approved changes\s*$/gm) ?? []).length, 1, "one button, one place");
    assert.match(src, /status === "approved" && live/, "only on an approved request");
    assert.match(src, /approvalIsLive\(/, "and only while the approval is live");
  });

  it("the reviewer's Reject button stays off until there is a reason, and the dialog says one is required", () => {
    const src = ui("review-ui.tsx");
    assert.match(src, /disabled=\{busy \|\| reason\.trim\(\)\.length === 0\}/);
    assert.match(src, /A reason is required/);
    assert.match(src, /Grant Permission to Publish/);
    assert.match(src, /Reject Changes/);
  });

  it("an item held by a request cannot be saved from either editor", () => {
    for (const f of ["content-screen.tsx", "doc-editor.tsx"]) {
      const src = ui(f);
      assert.match(src, /disabled=\{busy !== null \|\| locked/, `${f}: Save must be off while the item is held`);
      assert.match(src, /ReviewLockNotice/);
    }
  });

  it("the editors offer 'Submit for Verification' only to somebody who submits, never to a publisher", () => {
    for (const f of ["content-screen.tsx", "doc-editor.tsx"]) assert.match(ui(f), /canSubmit/, f);
    assert.match(read("src", "app", "website", "cms-ui", "chrome.ts"), /canSubmit: editor && !direct/);
  });
});

describe("what a narrowed grant opens", () => {
  const granted = ["website.dashboard", "website.products"];
  for (const m of websiteModules) {
    const expected = granted.includes(m.key);
    it(`${m.key}: ${expected ? "open" : "closed"} to a Dashboard + Products grant`, () => {
      assert.equal(moduleAllowed(m.key, granted, "website"), expected);
    });
  }
  it("a grant with no module rows opens all 12 screens but not the right to publish or to review", () => {
    for (const m of screens) assert.equal(moduleAllowed(m.key, [], "website"), true, m.key);
    for (const right of ["website.publish", "website.review"]) {
      assert.equal(moduleAllowed(right, [], "website"), false, right);
      assert.equal(moduleAllowed(right, [], "website", true), false, `${right}: not even for an administrator`);
    }
  });
  it("the review right is explicit-only, off by default and a narrowing of the dashboard, like the publishing right", () => {
    const review = websiteModules.find((m) => m.key === "website.review");
    assert.ok(review);
    assert.equal(review.explicitOnly, true);
    assert.equal(review.offByDefault, true);
    assert.equal(review.writeOf, "website.dashboard");
    assert.equal(moduleAllowed("website.review", ["website.dashboard", "website.review"], "website"), true);
    assert.equal(moduleAllowed("website.review", ["website.dashboard", "website.publish"], "website"), false, "publishing is not reviewing");
  });
});

describe("the dashboard shows only what the grant opens", () => {
  it("filters its module cards by the same grant the route guards read", () => {
    const src = read("src", "app", "website", "page.tsx");
    assert.match(src, /listUserModules\(user\.id, "website"\)/);
    assert.match(src, /MODULES\.filter\(\(m\) => allowed\.has\(`\/website\/\$\{m\.slug\}`\)/);
    // …and, where assignments are enforced, by what the person was assigned.
    assert.match(src, /allowed\.has\(`\/website\/\$\{m\.slug\}`\) && slugVisible\(scope, m\.slug\)/);
    assert.match(src, /dashboardSummary\(scope\)/);
  });
});

describe("the server surface cannot skip the permission layer", () => {
  it("every server action goes through a command, never straight to the service or the database", () => {
    const src = read("src", "lib", "actions", "website-cms.ts");
    assert.doesNotMatch(src, /@\/db/);
    assert.doesNotMatch(src, /\b(createItem|updateItem|transitionItems|deleteDraft|importWebsiteContent)\(/);
    const fns = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    assert.ok(fns.length >= 15, "the actions exist");
    for (const name of fns) {
      const body = src.slice(src.indexOf(`export async function ${name}`)).split(/\nexport async function /)[0];
      assert.match(body, /cms\./, `${name} must call a command`);
    }
  });
  it("every command asks who is asking before it does anything", () => {
    const src = read("src", "lib", "website-cms", "commands.ts");
    const fns = [...src.matchAll(/export function (\w+)\(/g)].map((m) => m[1]);
    assert.ok(fns.length >= 15);
    for (const name of fns) {
      const body = src.slice(src.indexOf(`export function ${name}(`)).split(/\nexport function /)[0];
      assert.match(body, /gate(Edit|AnyEdit|Publish|Review|Workflow|MediaWrite)\(/, `${name} must check a gate`);
    }
  });
  it("every edit gate says WHAT it is editing — a bare 'may edit products' is how an assignment gets skipped", () => {
    const src = read("src", "lib", "website-cms", "commands.ts");
    const calls = [...src.matchAll(/gateEdit\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(calls.length >= 10);
    for (const args of calls) assert.match(args, /,\s*\{/, `gateEdit(${args}) has no scope`);
    assert.match(read("src", "lib", "website-cms", "access.ts"), /export async function gateEdit\(kind: KindKey, scope: EditScope\)/);
  });
  it("publishing is still gated by website.publish everywhere except the one command that publishes an APPROVED request", () => {
    const src = read("src", "lib", "website-cms", "commands.ts");
    const body = (name: string) => src.slice(src.indexOf(`export function ${name}(`)).split(/\nexport function /)[0];
    for (const name of ["transitionContent", "publishAllPending", "refreshLiveSiteNow", "importSiteContent"]) {
      assert.match(body(name), /gatePublish\(\)/, `${name} must still ask for website.publish`);
    }
    const approved = body("publishApproved");
    assert.doesNotMatch(approved, /gatePublish/);
    assert.match(approved, /gateWorkflow\(\)/);
    assert.match(approved, /review\.publishApproved\(gate\.user, requestId,/, "it hands the service a request, never item ids");
    // The generic publishers are not reachable from the review service.
    const svc = read("src", "lib", "website-cms", "review-service.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(svc, /(transitionItems|publishPending|publishOrder|syncPublishedOrder)/);
  });
  it("every decision on a request asks for website.review, and every one of them checks a gate first", () => {
    const src = read("src", "lib", "website-cms", "commands.ts");
    const body = (name: string) => src.slice(src.indexOf(`export function ${name}(`)).split(/\nexport function /)[0];
    for (const name of ["assignWork", "revokeAssignment", "setEnforceAssignments", "approveRequest", "rejectRequest", "revokeApproval"]) {
      assert.match(body(name), /gateReview\(\)/, `${name} must ask for website.review`);
    }
    for (const name of ["submitForVerification", "withdrawRequest", "publishApproved", "readRequest"]) {
      assert.match(body(name), /gateWorkflow\(\)/, `${name} must ask for the workflow gate`);
    }
  });
  it("the review commands never take a kind or an owner from the caller for something that already exists", () => {
    const src = read("src", "lib", "website-cms", "commands.ts");
    const submit = src.slice(src.indexOf("export function submitForVerification(")).split(/\nexport function /)[0];
    assert.match(submit, /kindOfItem\(id\)/, "an item's kind is read from its row");
    assert.doesNotMatch(submit, /kind:\s*\w+.*ids/);
  });
  it("both public routes check the secret before reading anything, and fail closed", () => {
    for (const route of ["content/route.ts", "media/[id]/route.ts"]) {
      const src = read("src", "app", "api", "public", "website", ...route.split("/"));
      assert.match(src, /readSecret\("website\.cmsReadSecret"\)/);
      assert.match(src, /status: 503/);
      assert.match(src, /bearerMatches\(request, secret\)/);
      const check = src.indexOf("bearerMatches(request, secret)");
      const reads = [src.indexOf("await currentBundle"), src.indexOf("await readMedia")].filter((i) => i >= 0);
      for (const r of reads) assert.ok(check < r, `${route} reads before it checks the secret`);
    }
  });
  it("the editor's upload and thumbnail routes require a signed-in person with a Website module", () => {
    // Uploading is for editors. Looking at a picture is for editors AND for a reviewer, who may hold no content module and still has to see the old and the new image.
    const upload = read("src", "app", "api", "website", "media", "route.ts");
    assert.match(upload, /getCurrentUser\(\)/);
    assert.match(upload, /canEditAny\(user\.id\)/);
    const show = read("src", "app", "api", "website", "media", "[id]", "route.ts");
    assert.match(show, /getCurrentUser\(\)/);
    assert.match(show, /canReadMedia\(user\.id\)/);
  });
  it("the layout tells people while the live site is not connected, and nothing claims a prototype any more", () => {
    assert.match(read("src", "app", "website", "layout.tsx"), /<ConnectionNotice \/>/);
    for (const gone of ["mock-data.ts", "prototype.ts", "prototype-notice.tsx"]) assert.equal(existsSync(join(DIR, gone)), false, gone);
  });
});
