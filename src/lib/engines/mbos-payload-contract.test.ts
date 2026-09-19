import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

/* ---------------------------------------------------------------------------
 * THE OTHER DIRECTION OF THE WIRE, and nothing was looking down it.
 *
 * `mbos-wire.test.ts` beside this one guards everything the office SENDS: a
 * column the handset has nowhere to put throws inside one transaction and
 * empties the phone. This file guards what the handset sends BACK, where the
 * failure is the opposite shape and far quieter.
 *
 * A sync payload is parsed by a plain `z.object`, and a plain `z.object`
 * STRIPS what it does not declare. It does not refuse it, it does not log it,
 * it does not name it in a rejection — the field is simply gone by the time
 * the handler reads `parsed.data`, the write succeeds, and the column stays
 * null. Nothing is red at either end.
 *
 * `cancelReason` is how this was found, by hand. `data/lead-samples.ts` has
 * sent it since the funnel shipped, `sampleUpdateSchema` did not list it, and
 * so every trial a salesman called off stored an empty reason: he typed the
 * answer into the box, the app said saved, and it went nowhere. The next
 * sample went out exactly the same, which is the whole thing a cancellation
 * reason exists to prevent. It is almost certainly not the last of its kind —
 * there are twenty-one entity types on this wire and sixty payload shapes
 * between them, and the two halves are joined by a spelling and nothing else.
 *
 * Nothing but text can check it, for the same reason the file beside this one
 * gives: the handset is a separate TypeScript program that this one excludes
 * and that excludes this one, `insertAndQueue` takes a
 * `Record<string, unknown>` so every key is type-correct, and the two sides
 * meet only inside a phone. It type-checks, it lints, the integration tests
 * pass, and the salesman's sentence is gone.
 *
 * So: every field the handset puts in a payload is read against the schema
 * that will parse it, matched on the entity type and the op the way
 * `dispatchItem` matches them. A field the server genuinely does not want is
 * named in NOT_WANTED with the reason, and the last test in this file fails
 * if one of those is later accepted — a stale exemption is how a guard rots.
 * ------------------------------------------------------------------------- */

const SYNC_ACTIONS = "src/lib/actions/mbos.ts";
const HANDSET_DATA = "mbos-app/src/data";

/* ---------------------------------------------------------------------------
 * READING SOURCE AS TEXT, carefully enough to be believed.
 * ------------------------------------------------------------------------- */

/**
 * Comments out, and the punctuation inside string literals out with them.
 *
 * Both matter and for different reasons. The house style here is paragraphs of
 * prose above every payload, and one of them containing a `{` or a `,` moves
 * the brace depth or splits a key list in half — which reports fields that are
 * not there, on files whose comments are the most valuable thing in them. The
 * strings keep their CONTENTS, because `entityType: 'visit'` is read out of
 * one; only their braces and commas are neutralised.
 */
function readable(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "/*" || two === "//") {
      const end = two === "/*" ? src.indexOf("*/", i + 2) + 2 : src.indexOf("\n", i);
      const seg = src.slice(i, end <= 0 ? src.length : end);
      out += seg.replace(/[^\n]/g, " ");
      i += seg.length;
      continue;
    }
    const quote = src[i];
    if (quote === "'" || quote === '"' || quote === "`") {
      out += quote;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          out += "  ";
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        out += "{}[](),".includes(src[j]!) ? " " : src[j];
        j++;
      }
      out += src[j] === undefined ? "" : quote;
      i = j + 1;
      continue;
    }
    out += quote;
    i++;
  }
  return out;
}

/** The balanced span starting at `open`, which must be an opening bracket. */
function span(src: string, open: number): [number, number] {
  const shut = { "{": "}", "(": ")", "[": "]" }[src[open]!]!;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === shut) {
      depth--;
      if (depth === 0) return [open, i + 1];
    }
  }
  throw new Error(`unbalanced ${src[open]} at ${open}`);
}

/** Top-level comma-separated items of a bracketed body. */
function items(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The keys of one object literal, plus the spread expressions in it. */
function literal(text: string): { keys: string[]; spreads: string[] } {
  const keys: string[] = [];
  const spreads: string[] = [];
  for (const item of items(text.slice(1, -1))) {
    if (item.startsWith("...")) {
      spreads.push(item.slice(3).trim());
      continue;
    }
    const named = item.match(/^(\w+)\s*:([\s\S]*)$/);
    if (named) {
      /* `requiredProductName: undefined` is not a field on the wire — an
         undefined value does not survive `JSON.stringify`, so reading it as
         one would report a loss where nothing is sent at all. Only the bare
         literal is skipped; `args.gpsLat ?? undefined` can carry a value. */
      if (named[2]!.trim() === "undefined") continue;
      keys.push(named[1]!);
      continue;
    }
    /* `{ id, customerId }` — shorthand, which several of these use. */
    const shorthand = item.match(/^(\w+)$/);
    if (shorthand) keys.push(shorthand[1]!);
  }
  return { keys, spreads };
}

/* ---------------------------------------------------------------------------
 * WHAT A HANDSET SENDS.
 *
 * Three doors and one destination. `insertAndQueue` posts `{ ...row,
 * ...payloadExtras }`, `updateAndQueue` posts `{ id, ...patch,
 * ...payloadExtras }`, and `enqueue` is called directly where neither shape
 * fits. All three are read here rather than only the first two, because the
 * direct calls are where the awkward payloads live — and awkward is where a
 * field gets forgotten.
 * ------------------------------------------------------------------------- */

const OWNED = ["id", "clientCreatedAt", "deviceId", "syncState"];

type Slot = "wire" | "local";
type Sent = { entity: string; op: string; file: string; line: number; fields: Map<string, Slot> };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(path);
  }
  return out;
}

/**
 * The enclosing top-level function of an offset, for resolving a spread that
 * names one of its PARAMETERS rather than a local.
 *
 * `moveSample(id, customerId, patch, wire)` in `data/lead-samples.ts` is why
 * this exists, and it is the function the found bug lived in: seven call sites
 * each hand it a different object literal as `wire`, that literal is spread
 * straight into the payload, and none of its fields is visible at the
 * `updateAndQueue` call at all. Reading only the call would have checked
 * `customerId` and reported the other twenty-two as safe.
 */
function enclosing(src: string, at: number): { name: string; params: string[] } | null {
  const before = src.slice(0, at);
  const decls = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(/gm)];
  const last = decls[decls.length - 1];
  if (!last) return null;
  const open = src.indexOf("(", last.index! + last[0].length - 1);
  const [from, to] = span(src, open);
  return { name: last[1]!, params: parameterNames(src.slice(from + 1, to - 1)) };
}

/**
 * The names in a parameter list.
 *
 * `items` is not enough here and the reason is worth naming: it counts
 * brackets and not ANGLE brackets, so `patch: Record<string, unknown>` splits
 * down the middle of its own type and the parameter after it is lost. That is
 * a silent narrowing — the spread then reads as unresolvable rather than
 * wrong — which is exactly the kind of hole this file refuses elsewhere. A
 * parameter list is the one place `<` and `>` are always a matched pair, so
 * they are counted here and nowhere else.
 */
function parameterNames(list: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("{[(<".includes(ch)) depth++;
    else if ("}])>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      names.push(current);
      current = "";
    } else current += ch;
  }
  names.push(current);
  return names
    .map((p) => p.trim().match(/^(\w+)/)?.[1] ?? "")
    .filter(Boolean);
}

/** The object literals handed to `fn` at argument `index`, anywhere in a file. */
function argumentsAt(src: string, fn: string, index: number): string[] {
  const found: string[] = [];
  for (const call of src.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))) {
    const open = src.indexOf("(", call.index! + call[0].length - 1);
    /* The declaration itself, whose "arguments" are its parameter list —
       reading those would hand this back the TYPES rather than any payload. */
    if (/\bfunction\s*$/.test(src.slice(0, call.index!))) continue;
    let bounds: [number, number];
    try {
      bounds = span(src, open);
    } catch {
      continue;
    }
    const args = items(src.slice(bounds[0] + 1, bounds[1] - 1));
    const arg = args[index];
    if (arg?.startsWith("{")) found.push(arg);
  }
  return found;
}

/**
 * Every field one payload carries, following spreads until they run out.
 *
 * A spread that cannot be followed is a HOLE in the check rather than a pass,
 * so it is reported by name — an unresolved one silently narrows what this
 * test can see, which is exactly the failure mode it exists to prevent.
 */
function fieldsOf(
  src: string,
  text: string,
  at: number,
  unresolved: string[],
  depth = 0,
): Set<string> {
  const out = new Set<string>();
  if (depth > 4) return out;
  const { keys, spreads } = literal(text);
  for (const k of keys) out.add(k);

  for (const spread of spreads) {
    /* An inline literal — `...(args.priority ? { severity: … } : {})`. Every
       branch is taken, because either can reach the wire. */
    if (spread.includes("{")) {
      let i = 0;
      while ((i = spread.indexOf("{", i)) !== -1) {
        const [from, to] = span(spread, i);
        for (const f of fieldsOf(src, spread.slice(from, to), at, unresolved, depth + 1)) out.add(f);
        i = to;
      }
      continue;
    }

    const name = spread.replace(/\s*\?\?\s*\{\s*\}$/, "").trim();
    if (!/^\w+$/.test(name)) {
      unresolved.push(spread);
      continue;
    }

    /* `const base = await stamp('visit')` — the four columns every owned
       record carries, filled once in `data/write.ts`. */
    const stamped = new RegExp(`const ${name}\\s*=\\s*await stamp\\(`).exec(src);
    if (stamped) {
      for (const f of OWNED) out.add(f);
      continue;
    }

    const local = new RegExp(`const ${name}\\s*(?::[^=]*)?=\\s*\\{`).exec(src);
    if (local) {
      const open = src.indexOf("{", local.index + local[0].length - 1);
      const [from, to] = span(src, open);
      for (const f of fieldsOf(src, src.slice(from, to), at, unresolved, depth + 1)) out.add(f);
      continue;
    }

    /* A parameter of the enclosing function: the literals its callers pass. */
    const fn = enclosing(src, at);
    const index = fn?.params.indexOf(name) ?? -1;
    if (fn && index > -1) {
      const passed = argumentsAt(src, fn.name, index);
      if (passed.length) {
        for (const arg of passed) {
          for (const f of fieldsOf(src, arg, src.indexOf(arg), unresolved, depth + 1)) out.add(f);
        }
        continue;
      }
    }

    unresolved.push(spread);
  }

  return out;
}

/** Every payload the handset can post, read off its three outbox doors. */
function handsetPayloads(unresolved: string[]): Sent[] {
  const sent: Sent[] = [];

  for (const file of sourceFiles(HANDSET_DATA).concat(sourceFiles("mbos-app/app"))) {
    /* `data/write.ts` is the plumbing rather than a caller: its payload is
       `{ ...args.row, ...args.payloadExtras }`, which names no entity and no
       field. Reading it would report one unresolvable spread for ever. */
    if (file.endsWith("/write.ts")) continue;
    const src = readable(readFileSync(file, "utf8"));

    for (const door of ["insertAndQueue", "updateAndQueue", "enqueue"] as const) {
      for (const call of src.matchAll(new RegExp(`\\b${door}\\s*\\(\\s*\\{`, "g"))) {
        const [from, to] = span(src, src.indexOf("{", call.index!));
        const block = src.slice(from, to);

        const entity = block.match(/entityType:\s*['"](\w+)['"]/)?.[1];
        if (!entity) continue;
        const op =
          block.match(/\bop:\s*['"](\w+)['"]/)?.[1] ??
          (door === "insertAndQueue" ? "create" : door === "updateAndQueue" ? "update" : null);
        assert.ok(op, `${file}: an enqueue with no op — the shape has changed`);

        const fields = new Map<string, Slot>();
        /* `updateAndQueue` always sends the id, whatever the patch says. */
        if (door === "updateAndQueue") fields.set("id", "wire");

        /*
         * WHICH SLOT IS THE WIRE depends on whether the call has one.
         *
         * `row` and `patch` are the handset's own SQLite columns, in the
         * handset's own vocabulary — `cans` where the office says
         * `quantityCans`, `company` where it says `companyName` — and
         * `payloadExtras` is where a caller writes the office's word for the
         * same thing. Where a call HAS that object, the row's own names are
         * the local half and the extras are the authored half. Where it does
         * not, the row IS the payload and every name in it is a wire name,
         * which is the ordinary shape: a travel leg, an approval, a leave
         * request are all posted exactly as they were stored.
         */
        const authored = /(?:^|[{,]\s*)(?:payload|payloadExtras):/m.test(block);

        for (const part of ["payload", "row", "patch", "payloadExtras"]) {
          const key = new RegExp(`(?:^|[{,]\\s*)${part}:\\s*`, "m").exec(block);
          if (!key) continue;
          const rest = block.slice(key.index + key[0].length);
          if (!rest.trimStart().startsWith("{")) {
            unresolved.push(`${file}: ${part} is not an object literal`);
            continue;
          }
          const open = block.indexOf("{", key.index + key[0].length);
          const [a, b] = span(block, open);
          const slot: Slot =
            part === "payload" || part === "payloadExtras" || !authored ? "wire" : "local";
          for (const f of fieldsOf(src, block.slice(a, b), from + a, unresolved)) {
            if (slot === "wire" || !fields.has(f)) fields.set(f, slot);
          }
        }

        sent.push({
          entity,
          op,
          file,
          line: src.slice(0, from).split("\n").length,
          fields,
        });
      }
    }
  }

  return sent;
}

/* ---------------------------------------------------------------------------
 * WHAT THE SERVER ACCEPTS.
 *
 * One zod object per entity and op, named here exactly as `dispatchItem` and
 * the handlers under it route — several handlers open with
 * `if (item.op === "update") return handleXUpdate(...)`, and the update schema
 * is a different list of fields from the create one. Matching every op against
 * the create schema would report half the wire as broken and hide the half
 * that is.
 * ------------------------------------------------------------------------- */

type Route = { schema?: string; readsDirectly?: string[]; note?: string };

const ROUTES: Record<string, Route> = {
  "visit/create": { schema: "visitSchema" },
  "visit/update": { schema: "visitSchema" },
  "order/create": { schema: "orderSchema" },
  "order/update": { schema: "orderProgressSchema" },
  "payment/create": { schema: "paymentSchema" },
  "payment/update": { schema: "paymentUpdateSchema" },
  "complaint/create": { schema: "complaintSchema" },
  "sample/create": { schema: "sampleSchema" },
  "sample/update": { schema: "sampleUpdateSchema" },
  "lead/create": { schema: "leadSchema" },
  /* `leadSchema.partial()` — the same declared keys, every one optional. */
  "lead/update": { schema: "leadSchema" },
  "task/create": { schema: "taskSchema" },
  "task/update": { schema: "taskSchema" },
  "expense/create": { schema: "expenseSchema" },
  "attendance/create": { schema: "attendanceSchema" },
  "attendance/update": { schema: "attendanceSchema" },
  "customer/create": { schema: "customerCreateSchema" },
  "customer/update": { schema: "customerEditSchema" },
  "leave/create": { schema: "leaveSchema" },
  /*
   * The one branch with no schema at all. A withdrawal is the only change a
   * handset may make to a leave request, so `handleLeave` reads the two fields
   * it allows straight off the payload and refuses everything else by name —
   * which is a REFUSAL rather than a silent strip, and the loud direction.
   */
  "leave/update": { readsDirectly: ["id", "state", "cancelReason"] },
  "tour/create": { schema: "tourSchema" },
  "competitor/create": { schema: "competitorSchema" },
  "lead_validation/create": { schema: "leadValidationSchema" },
  "internal_note/create": { schema: "internalNoteSchema" },
  "approval/create": { schema: "approvalSchema" },
  "plan_day/create": { schema: "planDaySchema" },
  "plan_day/update": { schema: "planDaySchema" },
  "plan_stops/update": { schema: "planStopsSchema" },
  "expense_day/create": { schema: "expenseDaySchema" },
  "expense_day/update": { schema: "expenseDaySchema" },
  "travel_leg/create": { schema: "travelLegSchema" },
  "travel_leg/update": { schema: "travelLegSchema" },
  "expense_day_submit/create": { schema: "submitSchema" },
};

/** The keys one `const x = z.object({ … })` declares, at the top level only. */
function schemaFields(src: string, name: string): Set<string> {
  const at = src.indexOf(`const ${name} = z.object({`);
  assert.ok(at > -1, `${name} is gone from ${SYNC_ACTIONS} — this test needs updating with it`);
  const [from, to] = span(src, src.indexOf("{", at + `const ${name} = z.object(`.length));
  return new Set(literal(src.slice(from, to)).keys);
}

/* ---------------------------------------------------------------------------
 * FIELDS THE SERVER DELIBERATELY DOES NOT WANT.
 *
 * Every entry is a field a handset sends that no schema declares, and a REASON
 * it is right that none does. The list is short on purpose: a long one is a
 * list nobody reads, and this whole test is worth exactly what the shortness
 * of this list is worth. A field is silenced here only where sending it is
 * harmless AND the server has the fact from somewhere better.
 * ------------------------------------------------------------------------- */

const NOT_WANTED: Record<string, string> = {
  /*
   * THE ENVELOPE, not the record. `SyncItem` carries the client id, the device
   * and the client clock, and every handler reads `item.entityId` rather than
   * the payload's own `id` — so a schema declaring one would be a second copy
   * of an identity the item already states, and the two could disagree. They
   * ride in the payload because `insertAndQueue` posts the row it wrote, and
   * the row has to carry them for the handset's own screens.
   */
  "*.id": "the client id, read off item.entityId rather than the payload",
  "*.clientCreatedAt": "on the envelope; the server dates work by its own clock",
  "*.deviceId": "on the envelope, and a device claiming its own id is not evidence",
  "*.syncState": "the outbox's own bookkeeping — meaningless to the office",
  "*.lastSyncedAt": "the handset's own record of when it last heard, not a fact about the row",

  /*
   * WHO IS ASKING is the session, never the payload. `principal.user.id` is
   * established by the device token, and a schema that took a `userId` would
   * be a handset asserting whose leave and whose mileage this is — which is
   * the one thing on this wire a phone must not be able to say.
   */
  "leave/create.userId": "the principal says who; a payload saying it is a claim, not evidence",
  "travel_leg/create.userId": "the principal says who; a mileage claim naming its own owner is not evidence",

  /*
   * THE STATE MACHINE IS THE OFFICE'S. A leave request and an approval are
   * both raised `Pending` on the handset so its own screens can draw them, and
   * both are decided at a desk. A payload that could set one would be a phone
   * approving its own leave.
   */
  "leave/create.state": "raised Pending for the handset's own screens; deciding it is the office's",
  "approval/create.state": "the same — an approval that arrived already approved is not one",
  "approval/create.requestedAt": "the office stamps its own; a phone's clock is not evidence of when it was asked",

  /*
   * DERIVED THERE, and better derived there. `days` is the one worth naming:
   * the handset counts the span and `handleLeave` counts WORKING days against
   * the leave calendar, so a Friday-to-Monday request spends two days rather
   * than four. Taking the handset's number would be the worse of two answers
   * arriving by the back door.
   */
  "leave/create.days": "recounted as WORKING days against the leave calendar, which is the better answer",
  "leave/create.lossOfPay": "derived from the balance the office holds, not from the phone's copy of it",
  "leave/create.balanceSnapshot": "what the person was TOLD, kept on the phone so a later recompute cannot rewrite it",
  "attendance/update.workedMinutes": "derived from the marks; a handset that could type this could type an hour's work as a day",
  "attendance/update.status": "derived there, for the same reason",
  "*.lastActivityDate": "the server stamps its own `today()` — a phone's date is not evidence of when work happened",
  "lead/update.distributorName": "resolved from `distributorCustomerId`; a second copy of a name is one that can disagree",
  "lead/update.distributorSalesmanName": "resolved from `distributorSalesmanId`, the same way",

  /*
   * FOR THE HANDSET'S OWN REJECTION SCREEN, which is the one reader that can
   * only reach the payload. `sync_queue` snapshots it at enqueue, so a refused
   * order can still name the shop and say the value was never known — on the
   * screen the salesman is actually looking at, with no network and no
   * customer row to join against.
   */
  "order/create.customerName": "read back by /rejections so a refusal can name the shop",
  "payment/create.customerName": "the same",
  "visit/create.customerName": "the same",
  "order/create.valueUnavailable": "read back by /rejections so a refused order says the value was never known",
  "payment/create.localReceiptRef": "the TMP- number on the paper slip, generated here and shown here; the office matches on `reference`",

  /*
   * ALREADY ANSWERED BY ANOTHER FIELD ON THE SAME PAYLOAD, so declaring it
   * would be a second way to say one thing.
   */
  "sample/update.customerId": "sent on every mark so one landing on the CREATE branch is not refused for want of it",
  "sample/create.leadId": "the office collapsed leads and customers into one `customers` row; `customerId` IS the lead",
  "attendance/update.approvalId": "the approval syncs as its own entity naming this day as its subject",
};

test("every field the handset sends is one the server's schema accepts", () => {
  /* Read through `readable` for the same reason the handset is: these
     schemas carry paragraphs of prose between their fields, and a comma in
     one of them splits a field list down the middle. */
  const actions = readable(readFileSync(SYNC_ACTIONS, "utf8"));
  const unresolved: string[] = [];
  const sent = handsetPayloads(unresolved);

  assert.ok(
    sent.length > 40,
    `only ${sent.length} payloads found — the scan is broken, not the handset`,
  );
  assert.deepEqual(
    unresolved,
    [],
    "a payload this test cannot read is a payload it is not checking, and a " +
      "hole here looks exactly like a pass:\n  " + unresolved.join("\n  "),
  );

  const accepted = new Map<string, Set<string>>();
  const faults: string[] = [];

  for (const item of sent) {
    const key = `${item.entity}/${item.op}`;
    const route = ROUTES[key];
    assert.ok(
      route,
      `${item.file}:${item.line} sends a "${key}" and this test has no route for it — ` +
        "add it beside the handler in dispatchItem that answers it",
    );

    if (!accepted.has(key)) {
      accepted.set(
        key,
        route.schema
          ? schemaFields(actions, route.schema)
          : new Set(route.readsDirectly ?? []),
      );
    }
    const takes = accepted.get(key)!;

    for (const [field, slot] of item.fields) {
      /*
       * THE LOCAL HALF IS A DIFFERENT QUESTION and is deliberately not
       * asserted. `row`/`patch` beside a `payloadExtras` is the handset's own
       * SQLite table in the handset's own vocabulary — `cans` where the office
       * says `quantityCans`, `company` where it says `companyName`, `reason`
       * where it says `feedbackNotes` — and the extras object is where the
       * caller writes the office's word for the same thing. Every one of those
       * local names is dropped by design, forty-odd of them, and asserting
       * them would need an allowlist longer than this file with one line of
       * "this is the local spelling" per entry. A list that long is a list
       * nobody reads, and a real loss would hide in it within a release.
       *
       * What IS asserted is the half somebody AUTHORED for the wire: a
       * `payload`, a `payloadExtras`, or a row posted with neither beside it,
       * which makes the row itself the payload. That is where the found bug
       * was and where the next one will be — somebody writing a field down for
       * the office to read.
       */
      if (slot !== "wire") continue;
      if (takes.has(field)) continue;
      if (NOT_WANTED[`*.${field}`] || NOT_WANTED[`${key}.${field}`]) continue;
      faults.push(
        `${key} · ${field} — sent by ${item.file}:${item.line}, ` +
          `not declared by ${route.schema ?? "the handler's own reads"}`,
      );
    }
  }

  assert.deepEqual(
    [...new Set(faults)].sort(),
    [],
    "A zod object STRIPS what it does not declare — no refusal, no log, no " +
      "rejection row, nothing in /rejections. The salesman types this in, the " +
      "app says saved, the write succeeds, and the column stays null. Declare " +
      "the field on the schema and write it in the handler, or rename the " +
      "handset's field to the one the schema already has:\n  " +
      [...new Set(faults)].sort().join("\n  "),
  );
});

test("nothing on the not-wanted list has quietly become wanted", () => {
  const actions = readable(readFileSync(SYNC_ACTIONS, "utf8"));
  const stale: string[] = [];

  for (const entry of Object.keys(NOT_WANTED)) {
    const cut = entry.lastIndexOf(".");
    const scope = entry.slice(0, cut);
    const field = entry.slice(cut + 1);
    const routes: Route[] =
      scope === "*"
        ? Object.values(ROUTES)
        : ROUTES[scope]
          ? [ROUTES[scope]!]
          : [];
    assert.ok(
      scope === "*" || routes.length,
      `${entry} names a route this test does not have — the exemption cannot be checked`,
    );
    for (const route of routes) {
      if (!route.schema) continue;
      if (schemaFields(actions, route.schema).has(field)) {
        stale.push(`${entry} is declared by ${route.schema} now`);
      }
    }
  }

  assert.deepEqual(
    [...new Set(stale)],
    [],
    "these are accepted and should come off NOT_WANTED, or the list stops " +
      "meaning anything and the next real drop hides behind it:\n  " +
      [...new Set(stale)].join("\n  "),
  );
});
