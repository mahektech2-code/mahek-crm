/**
 * EVERY APP'S HEADER STARTS THE SAME WAY: switcher, sidebar collapse, wordmark.
 *
 * Mahek's instruction is that those three are mandatory in every MahekOne app.
 * They were written out by hand in each shell and drifted — the Sales
 * Dashboard had no collapse, Accounts and the Founder desks no switcher, the
 * CRM hid its switcher from anybody holding one app — and nothing noticed,
 * because a missing control is not an error anywhere. `HeaderLead` draws all
 * three; this reads every shell as TEXT and fails on one that does not render
 * it, or that puts the switcher back behind a condition.
 *
 * `SHELLS` must name every web app in the registry, so a new app fails here
 * until somebody says which file draws its header — which is the moment to
 * give it the three controls, not after a person reports them missing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPS, type AppId } from "./apps";

const ROOT = join(__dirname, "..", "..");

/** The file(s) that draw each web app's header. Every one must render HeaderLead. */
const SHELLS: Partial<Record<AppId, string[]>> = {
  crm: ["src/components/shell/header.tsx"],
  sales: ["src/app/sales/sales-shell.tsx"],
  accounts: ["src/app/accounts/accounts-shell.tsx"],
  hrms: ["src/app/hrms/_ui/hrms-shell.tsx"],
  admin: ["src/app/admin/_shell/admin-shell.tsx"],
  /* The desks draw the Command Centre's own FounderHeader, from chrome.tsx. */
  founder: ["src/app/founder/(command)/chrome.tsx"],
  enquiries: ["src/app/enquiries/enquiries-shell.tsx"],
  erp: ["src/app/erp/_ui/erp-shell.tsx"],
  website: ["src/app/website/website-shell.tsx"],
  hire: ["src/app/hire/_ui/hire-shell.tsx"],
  docs: ["src/app/docs/docs-shell.tsx"],
};

/*
 * THE FACTORY APP IS A PHONE SCREEN, drawn to the design's phone frame: a top
 * bar with the person, the work place and the network, and a bottom nav. A
 * desktop header with a sidebar collapse has nothing to collapse there, and a
 * switcher would be a way off the floor's only app on a shared station phone.
 * The Production Head's way to the launcher is the avatar menu.
 */
const PHONE_FRAME: AppId[] = ["factory"];
const webApps = APPS.filter((a) => a.built && !a.mobileOnly && !a.retiredInto && !PHONE_FRAME.includes(a.id));

describe("every app's header", () => {
  test("every web app names the shell that draws its header", () => {
    const missing = webApps.map((a) => a.id).filter((id) => !SHELLS[id]);
    assert.deepEqual(missing, [], "add the new app's shell file to SHELLS, and render HeaderLead in it");
  });

  for (const [app, files] of Object.entries(SHELLS)) {
    for (const file of files!) {
      test(`${app}: ${file} renders HeaderLead`, () => {
        const src = readFileSync(join(ROOT, file), "utf8");
        assert.match(src, /<HeaderLead\b/, "the switcher, collapse and wordmark come from HeaderLead");
      });
    }
  }

  test("the switcher is never drawn behind a condition on how many apps somebody holds", () => {
    for (const files of Object.values(SHELLS)) {
      for (const file of files!) {
        const src = readFileSync(join(ROOT, file), "utf8");
        assert.doesNotMatch(
          src,
          /apps\.length\s*>\s*1\s*\?\s*(\(\s*)?<(span[^>]*>\s*<)?AppSwitcher/,
          `${file} hides the switcher from somebody with one app — their only way back to the launcher`,
        );
      }
    }
  });
});
