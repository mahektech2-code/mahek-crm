import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWireMarkup, type WireNode } from "./wire-markup";

const node = (n: WireNode | undefined) => {
  assert.ok(n && typeof n !== "string");
  return n;
};

test("a page's own wireframe source parses into the real components", () => {
  const r = parseWireMarkup(`<Wireframe url="/crm/call-log" nav={["Dashboard", "#Daily calling", "Call Log"]} active="Call Log" caption="The Call Log">
  <WfBar>
    <WfTitle sub="Your book">Call Log</WfTitle>
    <WfSpacer />
    <WfButton primary>Call Customer A</WfButton>
    <Hotspot n={1} />
  </WfBar>
  <WfTable columns={["Customer", "Reason"]} rows={[["Customer A", "Order due"],]} />
</Wireframe>`);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const frame = node(r.nodes[0]);
  assert.equal(frame.tag, "Wireframe");
  assert.deepEqual(frame.props.nav, ["Dashboard", "#Daily calling", "Call Log"]);
  const bar = node(frame.children[0]);
  assert.equal(bar.tag, "WfBar");
  assert.deepEqual(node(bar.children[0]).children, ["Call Log"]);
  assert.equal(node(bar.children[2]).props.primary, true);
  assert.equal(node(bar.children[3]).props.n, 1);
  assert.deepEqual(node(frame.children[1]).props.rows, [["Customer A", "Order due"]]);
});

test("anything that could run or style is dropped, not obeyed", () => {
  const r = parseWireMarkup(
    `<Wireframe url="/x" onClick={alert(1)} style={{color:"red"}}><script>alert(1)</script><div className="evil"><WfText>kept</WfText></div><WfButton onClick={() => steal()}>Go</WfButton></Wireframe>`,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const frame = node(r.nodes[0]);
  assert.deepEqual(Object.keys(frame.props), ["url"]);
  const script = node(frame.children[0]);
  assert.equal(script.tag, "group", "an unknown tag is a plain group");
  const div = node(frame.children[1]);
  assert.deepEqual(div.props, {});
  assert.equal(node(div.children[0]).tag, "WfText");
  assert.deepEqual(node(frame.children[2]).props, {});
});

test("comments and expressions in children vanish", () => {
  const r = parseWireMarkup(`<WfCard>{/* a note */}<WfText>a</WfText>{someVar}</WfCard>`);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(node(r.nodes[0]).children.length, 1);
});

test("a broken drawing says so rather than drawing half", () => {
  assert.equal(parseWireMarkup(`<Wireframe url="/x`).ok, false);
  assert.equal(parseWireMarkup(``).ok, false);
});

/* Every wireframe the pages draw is one the assistant may copy, so every one must parse. */
const ASK = join(process.cwd(), "src/docs/_generated/ask.json");
test("every wireframe in the written pages parses", { skip: !existsSync(ASK) }, () => {
  const sections = (JSON.parse(readFileSync(ASK, "utf8")) as { sections: Array<{ text: string; slug: string }> }).sections;
  let seen = 0;
  for (const s of sections) {
    for (const m of s.text.matchAll(/```wireframe\n([\s\S]*?)\n```/g)) {
      seen += 1;
      const r = parseWireMarkup(m[1]);
      assert.ok(r.ok, `${s.slug}: ${r.ok ? "" : r.error}`);
      if (r.ok) assert.equal(node(r.nodes[0]).tag, "Wireframe");
    }
  }
  assert.ok(seen > 50, `only ${seen} wireframes found`);
});
