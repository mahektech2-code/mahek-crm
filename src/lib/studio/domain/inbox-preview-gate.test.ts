import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { previewAllowed } from "./inbox-preview-gate";

const LOCAL = "postgres://postgres:postgres@localhost:5432/mahekone_inbox_ui";

describe("the Inbox's local-preview gate", () => {
  test("is on only with the explicit switch, a local database of ours, and a non-production build", () => {
    assert.equal(previewAllowed({ NODE_ENV: "development", STUDIO_INBOX_PREVIEW: "1", DATABASE_URL: LOCAL }), true);
    assert.equal(previewAllowed({ NODE_ENV: "test", STUDIO_INBOX_PREVIEW: "1", DATABASE_URL: "postgres://u:p@127.0.0.1/mahekone" }), true);
  });
  test("is never on in production, whatever else is set", () => {
    assert.equal(previewAllowed({ NODE_ENV: "production", STUDIO_INBOX_PREVIEW: "1", DATABASE_URL: LOCAL }), false);
  });
  test("is off without the switch, or with anything but 1", () => {
    for (const v of [undefined, "", "0", "true", "yes"]) assert.equal(previewAllowed({ NODE_ENV: "development", STUDIO_INBOX_PREVIEW: v, DATABASE_URL: LOCAL }), false);
  });
  test("is off for a shared host, an unparseable URL or another database name", () => {
    const on = { NODE_ENV: "development", STUDIO_INBOX_PREVIEW: "1" };
    assert.equal(previewAllowed({ ...on, DATABASE_URL: "postgres://u:p@db.example.com:5432/mahekone" }), false);
    assert.equal(previewAllowed({ ...on, DATABASE_URL: "postgres://u:p@db:5432/mahekone" }), false);
    assert.equal(previewAllowed({ ...on, DATABASE_URL: "not a url" }), false);
    assert.equal(previewAllowed({ ...on, DATABASE_URL: undefined }), false);
    assert.equal(previewAllowed({ ...on, DATABASE_URL: "postgres://u:p@localhost/postgres" }), false);
    assert.equal(previewAllowed({ ...on, DATABASE_URL: "postgres://u:p@localhost/neondb" }), false);
  });
});
