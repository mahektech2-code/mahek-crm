import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STALE_SAVE_MESSAGE,
  UNREACHABLE_MESSAGE,
  actionFailure,
  isStaleBuildError,
  nextPollMs,
  safeToReload,
} from "./version-skew";

const root = join(__dirname, "..", "..");

test("Next's own not-found error reads as a stale page", () => {
  const e = new Error('Server Action "7f3a…" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action');
  assert.equal(isStaleBuildError(e), true);
  assert.equal(actionFailure(e), STALE_SAVE_MESSAGE);
});

test("a chunk the new image no longer carries reads as a stale page", () => {
  const e = new Error("Loading chunk 4821 failed.");
  e.name = "ChunkLoadError";
  assert.equal(isStaleBuildError(e), true);
});

test("a dropped connection is a different sentence", () => {
  assert.equal(isStaleBuildError(new TypeError("Failed to fetch")), false);
  assert.equal(actionFailure(new TypeError("Failed to fetch")), UNREACHABLE_MESSAGE);
  assert.equal(actionFailure(undefined), UNREACHABLE_MESSAGE);
});

function doc(dialog: boolean, active: Partial<HTMLElement> | null) {
  return {
    querySelector: () => (dialog ? ({} as Element) : null),
    activeElement: active as Element | null,
  } as unknown as Pick<Document, "querySelector" | "activeElement">;
}

test("a reload never eats a form somebody is in", () => {
  assert.equal(safeToReload(doc(false, { tagName: "BODY", isContentEditable: false })), true);
  assert.equal(safeToReload(doc(false, null)), true);
  assert.equal(safeToReload(doc(true, { tagName: "BODY", isContentEditable: false })), false);
  assert.equal(safeToReload(doc(false, { tagName: "INPUT", isContentEditable: false })), false);
  assert.equal(safeToReload(doc(false, { tagName: "TEXTAREA", isContentEditable: false })), false);
  assert.equal(safeToReload(doc(false, { tagName: "DIV", isContentEditable: true })), false);
});

test("hundreds of tabs do not poll in step", () => {
  assert.equal(nextPollMs(300_000, 0), 225_000);
  assert.equal(nextPollMs(300_000, 1), 375_000);
  assert.equal(nextPollMs(300_000, 0.5), 300_000);
});

test("the build passes a fixed action key, as a secret and never a build-arg", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const workflow = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
  assert.match(dockerfile, /--mount=type=secret,id=actions_key/);
  assert.match(dockerfile, /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
  assert.doesNotMatch(dockerfile, /ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
  assert.match(workflow, /actions_key=\$\{\{ secrets\.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \}\}/);
});

test("the guard is mounted for every app, and Caddy waits out a restart", () => {
  /* Through StaffChrome: every app's page, never a customer's or vendor's link. */
  assert.match(readFileSync(join(root, "src/app/layout.tsx"), "utf8"), /<StaffChrome \/>/);
  assert.match(readFileSync(join(root, "src/components/shell/staff-chrome.tsx"), "utf8"), /<VersionGuard \/>/);
  assert.match(readFileSync(join(root, "Caddyfile"), "utf8"), /lb_try_duration\s+\d+s/);
});
