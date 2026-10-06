import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POLISH_CONTEXT_TURNS,
  POLISH_SYSTEM,
  buildPolishPrompt,
  cleanPolished,
  conversationExcerpt,
} from "./whatsapp-reply-polish";

const turn = (fromThem: boolean, text: string, i = 0) => ({
  fromThem,
  text,
  at: new Date(Date.UTC(2026, 9, 6, 4, i)).toISOString(),
});

test("the model is forbidden from adding a commitment the draft did not make", () => {
  assert.match(POLISH_SYSTEM, /NEVER add a fact/);
  assert.match(POLISH_SYSTEM, /same language and script as the draft/);
});

test("the excerpt names both sides and keeps only the recent end", () => {
  const turns = Array.from({ length: POLISH_CONTEXT_TURNS + 5 }, (_, i) => turn(i % 2 === 0, `m${i}`, i));
  const out = conversationExcerpt(turns, "Colour Camp");
  const lines = out.split("\n");
  assert.equal(lines.length, POLISH_CONTEXT_TURNS);
  assert.ok(!out.includes("m4\n") && lines[0].endsWith("m5"));
  assert.ok(out.includes("Colour Camp: m24"));
  assert.ok(out.includes("Mahek: m23"));
});

test("an empty conversation says so rather than sending nothing", () => {
  assert.equal(conversationExcerpt([turn(true, "  ")], "X"), "(no earlier messages)");
});

test("a long message is clipped so it cannot crowd out the rest", () => {
  const out = conversationExcerpt([turn(true, "a".repeat(5000))], "X");
  assert.ok(out.length < 700);
  assert.ok(out.endsWith("…"));
});

test("the draft and the conversation are both fenced; a rewrite carries its instruction", () => {
  const p = buildPolishPrompt({
    turns: [turn(true, "where is my order?")],
    customerName: "Shree Paints",
    draft: "dispatched today bill 1119",
    mode: "rewrite",
    instruction: "make it Hindi",
  });
  assert.equal(p.split("-----").length - 1, 4);
  assert.ok(p.includes("dispatched today bill 1119"));
  assert.ok(p.includes("Shree Paints: where is my order?"));
  assert.ok(p.includes("make it Hindi"));
});

test("a rewrite with no instruction is an ordinary improvement", () => {
  const p = buildPolishPrompt({ turns: [], customerName: "", draft: "ok", mode: "rewrite", instruction: "  " });
  assert.ok(p.includes("Improve the draft"));
});

test("quotes and fences the model was not asked for are taken off", () => {
  assert.equal(cleanPolished('"Hello, your order is on its way."'), "Hello, your order is on its way.");
  assert.equal(cleanPolished("-----\nHi\n-----"), "Hi");
  assert.equal(cleanPolished("He said \"ok\" and left"), 'He said "ok" and left');
});
