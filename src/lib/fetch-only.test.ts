import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenedDirectly } from "./fetch-only";

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });

test("typing the address, a link or a frame is refused; our viewer's fetch is not", () => {
  assert.equal(isOpenedDirectly(h({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" })), true);
  assert.equal(isOpenedDirectly(h({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" })), true);
  assert.equal(isOpenedDirectly(h({ "sec-fetch-mode": "no-cors", "sec-fetch-dest": "embed", "sec-fetch-site": "same-origin" })), true);
  assert.equal(isOpenedDirectly(h({ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-site": "cross-site" })), true);
  assert.equal(isOpenedDirectly(h({ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" })), false);
  assert.equal(isOpenedDirectly(h({ "sec-fetch-mode": "same-origin", "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" })), false);
  assert.equal(isOpenedDirectly(h({})), false, "a request with no metadata is let through");
});
