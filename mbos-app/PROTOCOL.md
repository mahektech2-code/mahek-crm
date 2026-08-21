# MBOS sync protocol

The contract between the handset and MahekOne. Both sides are written against
this document; neither may change a shape without changing it here first.

Server lives in the MahekOne Next.js app at `src/app/api/mbos/**`.
Client lives in `mbos-app/src/sync/**`.

---

## 0. The one fact

**The UI reads the local store, always. It never awaits the network.** A write
returns as soon as SQLite has it. Sync is a background reconciliation between
two stores that are both allowed to be right, not a request-response call the
screen is waiting on.

Everything below follows from that.

---

## 1. Identifiers

Every record gets a **client id** at creation, on the device, before anything
reaches a server: `mbos_<entity>_<uuidv4>`.

That id is the primary key on both sides. The server does **not** mint a
replacement — it stores the client id as `id`. This is what lets an offline
visit own an offline order that owns an offline payment, with all three
referencing each other correctly before any of them exists on a server.

Some records additionally get a **server-assigned display number** — an order
number, a receipt number — drawn from a configured series on first successful
sync. Until then the screen shows the client reference and says so. Two
salesmen offline must never generate the same number, which is exactly why the
number is not the identity.

**Device id**: one per install, `expo-crypto` random, in SecureStore, on every
record as `deviceId`.

---

## 2. Sync state

Every local row carries one of:

| State | Means |
|---|---|
| `local` | Written, not yet queued (transient; the write path queues immediately) |
| `queued` | In the outbox, waiting for connectivity or its turn |
| `syncing` | In flight |
| `synced` | The server has it and acknowledged |
| `failed` | Retries exhausted. Shown, retryable by hand. |
| `rejected` | The server refused it. **Retained.** See §6. |
| `blocked` | A record it depends on was rejected or failed. See §5. |
| `conflicted` | A mutable record lost a merge. Both versions kept. See §7. |

`synced` is the only state that means the office can see it. Nothing in the UI
may imply otherwise — a queued payment is money the business has not seen.

---

## 3. The outbox

One table, `sync_queue`:

```
id              client id of the queue item
entityType      'visit' | 'order' | 'payment' | 'attendance' | ...
entityId        client id of the record
op              'create' | 'update'
payload         JSON snapshot at enqueue time
dependsOn       JSON array of client ids that must be `synced` first
attempts        int
lastAttemptAt   epoch ms
nextAttemptAt   epoch ms — backoff gate
state           'queued' | 'syncing' | 'failed' | 'rejected' | 'blocked'
failureReason   human-readable, from the server
failureCode     machine-readable, from the server
```

**Ordering is dependency order, not creation order.** Each pass topologically
sorts the ready set. An item whose dependencies are not all `synced` is not
eligible, however old it is.

**Backoff**: 2s, 8s, 30s, 2m, 10m, 30m, then `failed`. Jittered. `nextAttemptAt`
is the gate, so a restart resumes the schedule rather than restarting it.

---

## 4. Requests

### `POST /api/mbos/sync`

```jsonc
{
  "deviceId": "...",
  "cursor": "<opaque, from the last pull>",
  "items": [
    {
      "queueId": "...",
      "entityType": "order",
      "entityId": "mbos_order_...",
      "op": "create",
      "idempotencyKey": "<entityId>:<op>:<payloadHash>",
      "clientCreatedAt": 1754900000000,
      "dependsOn": ["mbos_visit_..."],
      "payload": { }
    }
  ]
}
```

**Idempotency is mandatory.** The server stores every `idempotencyKey` it has
accepted. A replayed key returns the original result and writes nothing. This
is what makes "retry a request whose response we never saw" safe, which on a
2G connection in a market is most of them.

Response:

```jsonc
{
  "results": [
    { "queueId": "...", "status": "accepted", "serverId": "...",
      "serverNumber": "MBOS/26-27/0041", "serverReceivedAt": 1754900001234 },
    { "queueId": "...", "status": "rejected", "code": "credit_blocked",
      "message": "Om Sai Enterprises is credit-blocked. Ring accounts on 0712-...",
      "blocks": ["mbos_payment_..."] },
    { "queueId": "...", "status": "conflict", "serverVersion": { },
      "resolution": "server_wins" }
  ],
  "pull": { "cursor": "...", "customers": [], "products": [], "timeline": [],
            "config": { }, "notifications": [], "transcripts": [],
            "journeyStops": [], "planDays": [], "approvals": [],
            "leaveBalances": [] }
}
```

One round trip does both directions. A salesman who gets thirty seconds of
signal between two shops should spend it on both, not on a push that leaves the
book stale.

### 4.1 What is inside `payload`

**This section is the whole contract, and it was missing.** For as long as it
said `"payload": { }` the two halves were written independently and drifted
into two vocabularies, which is the worst possible way to disagree: an unknown
field is not an invalid one, so half of it was REFUSED and the other half was
silently dropped. An order sent `cans` to a server reading `quantityCans` and
was rejected as invalid; a visit sent `checkIn: { lat, lng, at }` to a server
reading `checkInLat`, and landed with a customer and nothing else.

**The payload speaks MahekOne's vocabulary, not the handset's.** The local
tables keep their own column names — they are read by screens built to a
design that uses its own words — and the wire carries the names the database
and the rest of MahekOne already use. Where a value has to be translated, the
translation is a named function on the client with the mapping written out, so
it can be tested and so the reason survives.

| Entity | Required | Optional |
|---|---|---|
| `visit` | `customerId` | `checkInAt` `checkInLat` `checkInLng` `checkInAccuracyM` `checkOutAt` `checkOutLat` `checkOutLng` `checkOutAccuracyM` `durationSeconds` `outcome` `notes` `transcript` `transcriptIsAi` `shopPhotoId` `custPhotoId` `voiceNoteId` `journeyPlanStopId` `wasPlanned` `deviationReason` `nextFollowUpDate` |
| `order` | `customerId` `lines[]` (`productId` + `quantityCans`, `ratePaise` optional) `totalAmountPaise` | `orderedAt` `creditDays` `expectedDispatch` `outstandingAsOfPaise` `priceTag` `visitId` |
| `payment` | `customerId` `amountPaise` | `receivedAt` `mode` `reference` `note` `billIds[]` `visitId` |
| `complaint` | `customerId` `category` `description` | `severity` `mobileNumber` `requestCn` `visitId` |
| `sample` | `customerId` | `productId` `quantityCans` `requestedDate` `followUpDate` `feedbackNotes` `visitId` |
| `lead` | `name` `mobile` | `companyName` `city` `area` `source` `estimatedPotentialPaise` `stage` `nextFollowUpDate` `notes` `lostReason` `archived` `convertedCustomerId` |
| `task` | `title` | `description` `customerId` `priority` `dueDate` `status` `completionNote` `completionPhotoId` `snoozedTo` `snoozeReason` |
| `expense` | `category` `amountPaise` `expenseDate` | `description` `billPhotoId` `claimId` |
| `attendance` | `day` | `checkInAt` `checkInLat` `checkInLng` `checkInAccuracyM` `checkOutAt` `checkOutLat` `checkOutLng` `checkOutAccuracyM` `selfieId` `withinGeofence` `geofenceDistanceM` `regularisationRequested` `regularisationReason` |
| `leave` | `kind` `fromDate` `toDate` | `halfDay` `reason` |
| `approval` | `type` `subjectType` `subjectId` | `reason` |
| `customer` (create) | `name` `phone` `city` | `contactPerson` `address` `fromLeadId` `estimatedPotentialPaise` `gpsLat` `gpsLng` |
| `plan_day` | `answer` (`agreed` \| `refused`) | `reason` (REQUIRED on a refusal) `counterCity` |
| `customer` (update) | `customerId` | any of the contact and location fields; never a credit field |

**The vocabularies that differ, and where the mapping lives:**

| | Handset | Wire | |
|---|---|---|---|
| visit outcome | `closed_now` | `not_available` | `data/visits.ts` |
| lead stage | `Converted` | `won`, others lower-cased | `data/leads.ts` |
| lead notes | a list of `{ at, text }` | one string, dated lines | `data/leads.ts` |
| task priority | `Normal` | `medium` | `data/tasks.ts` |
| complaint category | `Damaged goods` … | `packaging_damage` … | `data/requests.ts` |
| approval type | `order_over_credit` | `order`, reason keeps the why | server-side alias |

**An update payload is PARTIAL.** It names the id and the fields that changed.
Absent means unchanged — never "set to null" — and each entity has its own
partial schema on the server rather than being parsed against the create one.
An update naming a record the server has not received yet answers `retry`, not
`rejected`: the create is behind it in the same outbox.

**Extra fields are allowed and ignored.** `customerName` rides along on several
payloads so a REFUSAL can name the shop on the handset, which is the screen the
salesman is actually looking at. Nothing on the server reads it.

**Nulls are accepted wherever a value is optional.** The handset writes `null`
for "nothing here" throughout its own tables, so a schema that took only
`undefined` refused the ordinary case.

### 4.2 A plan is agreed, not issued

**The office proposes a city; the salesman answers.** A day moves
`proposed → refused → agreed → planned`, and only the salesman picks the
customers — he is the one who knows whether that market is open on a Wednesday,
or that two cities back to back is 340 km in a day.

- `planDays` comes DOWN with each day and its state. Without it a month laid out
  in advance is invisible on the handset, because a stop only exists once a day
  is already `planned`.
- `plan_day` goes UP with his answer. A refusal without a reason is refused by
  the server: the manager would have nothing to act on, and the day would sit
  unplanned while each waited for the other.
- `plan_stops` goes UP with the shops he picked, in the order he means to walk
  them, and the server moves the day to `planned`. The payload is the WHOLE
  answer rather than a difference: sending a shorter list is how a shop is
  unpicked, so a merge on the server would make unpicking impossible. Stops
  already visited are kept; the rest are replaced.
- The handset may not move a day to `planned` on its own. Picking is what does
  it, and picking nothing leaves the day `agreed` — an empty day claiming to be
  a route is the one state this model exists to prevent.
- A shop that has left his book since he picked it is dropped and COUNTED, and
  he is notified. Refusing the whole day over one stale id would lose the
  nineteen he got right; dropping it silently is how somebody walks a day
  missing a stop they chose and finds out at four in the afternoon.
- The manager cannot overrule a refusal into `planned` either. They may take
  his counter-proposal or put a different city back to him, and nothing else.

### 4.3 The pull channels

Everything the office owns comes down through the one delta. A channel that is
declared and never sent is worse than one that does not exist: the handset
applies it, finds nothing, and shows an empty screen that reads as "nobody has
published anything".

| Channel | Shape | Merge |
|---|---|---|
| `customers` `products` `timeline` `journeyStops` `planDays` `notifications` `approvals` `leaveBalances` `transcripts` | rows in the handset's own column names | upsert by id |
| `priceList` | `{ priceTag, productId, ratePaise }`, in force today | **replaced wholesale** |
| `schemes` | `{ id, name, eligibility, benefit, validFrom, validTo }` | upsert by id |
| `documents` `courses` | rows, narrowed exactly as the bootstrap narrows them | upsert by id |
| `deletions` | `{ entity, ids }[]` — `entity` is the HANDSET's table name | delete by id |
| `config` | every `mbos.*` key | replace |

**`priceList` is replaced rather than merged** because a rate that was withdrawn
has to disappear, and a per-row upsert leaves it behind — an order priced from a
rate nobody sells at.

**`deletions` is the channel that has no other way of existing.** A deleted row
has no `updated_at` for a delta to notice, so without a tombstone a withdrawn
document, a removed stop and a reassigned customer stay on the phone for ever.
Reference data only: nothing the salesman authored is ever deleted by a sync,
not a rejected order and not a visit that lost a conflict.

### 4.4 Where each activity was done

Every item carries an optional `location`, a **sibling of `payload` and never a
field inside it**:

```json
{ "lat": 21.1601, "lng": 79.0805, "accuracyM": 18,
  "capturedAt": 1787310000000, "ageSeconds": 90, "source": "trail" }
```

The sibling placement is load-bearing: `idempotencyKey` is a hash of the
payload, so folding a position in would make the same order enqueued twice from
two spots on a street into two orders. Where somebody stood is a fact about the
act, not part of the record's content.

**It is recorded by the dispatcher, not by each handler.** Twelve handlers each
remembering to write a coordinate is eleven remembering and one forgetting —
which was the state this replaced, four tables out of twenty-seven. A
thirteenth entity type gets it by existing.

**Age is part of the reading, exactly as accuracy is.** Almost every position
here is one the day's trail had already taken, which is what makes this cost no
battery and add no delay — and it is why the reader has to be told how old it
was. Four minutes is evidence of where somebody stood; four hours is not.
`mbos.location.activityFixMaxAgeSeconds` decides what the screens CALL stale,
never what is stored.

**A save is never delayed or lost for a position.** `whereNow()` answers from
the freshest fix already known and never waits on the radio; the top-up happens
after the write has returned. A missing fix, a refused permission or a nonsense
coordinate all leave the activity intact.

**No coordinates with a `reason` is a different fact from no `location` at
all.** The first says we asked and could not — indoors in a concrete godown, or
permission refused. The second says nothing asked. A screen that could not tell
them apart would say "no location" for both.

**It is written only for an ACCEPTED item.** A refused order did not happen, and
a position for it is a record of somewhere a salesman stood while something
failed.

**Paperwork carries none.** Leave requests, agreeing a day and picking shops
send `location: false` from the handset: they happen on a sofa at nine in the
evening as often as anywhere, and recording a salesman's home coordinates
because he replied to his manager answers no question anybody has.

### `POST /api/mbos/positions`

`{ positions: [{ id, at, lat, lng, accuracyM }] }`, at most 500, oldest first.

**Its own endpoint rather than a sync entity type, deliberately.** The outbox is
dependency-ordered and retries for ever, because a visit that never arrives is a
call nobody has a record of. A position is the opposite kind of thing: one of a
hundred, worth nothing alone, and one lost is a slightly coarser line on a map.
Through the outbox it would queue a hundred rows a day in front of the visit
behind them, on a 2G connection, for no gain.

So they queue in their own local table, go up in batches, and are DELETED once
acknowledged — sent-but-unacknowledged is the only state worth having, and a
failure is silent because there is nothing the salesman could do about it.

**It runs between the check-in and the check-out and not one second either
side.** A track that carried on after the day was closed would be following
somebody home. `mbos.location.trackWhileWorking` is checked in this route as
well as on the handset, because a hidden control is not a disabled feature; the
answer `{ tracking: "off" }` tells a handset to stop and drop what it holds.

### `POST /api/mbos/media`

Multipart, one file, `entityId` + `kind` + `clientId`. Resumable by re-POSTing
the same `clientId`; the server dedupes on it. Media is a **separate queue** —
the parent record syncs first with media pending, and 840 KB of shop photos
never delays a payment.

### `POST /api/mbos/auth/login` · `/refresh` · `/bootstrap`

`bootstrap` returns the scoped snapshot: the salesman's own book, the active
catalogue, today's and tomorrow's plan, open tasks/samples/leads, outstanding
and credit per customer, the last N timeline events each, and the full config.
It is the only call that may be large; everything after it is a delta on
`cursor`.

---

## 5. Dependencies

`dependsOn` carries client ids. The queue will not send an item until every id
in it is `synced` locally.

If a dependency is **rejected** or **failed**, its dependents become `blocked` —
not sent, not silently dropped. The brief's case: a payment against an order
the server refused must not arrive looking like a payment against nothing.

`blocks` in a rejection response names the dependents the server already knows
about, so the client can block them without waiting to work it out.

---

## 6. Rejection

The server may refuse a record the client already accepted and already told the
salesman was saved. Credit limit moved, customer blocked, product discontinued,
bill already settled, price list changed.

- Status `rejected`, with a **machine code** and a **human sentence**.
- The record stays in the local store. It is never deleted.
- The salesman is notified, naming the customer and the reason.
- Dependents are blocked.
- `/rejections` — the review screen — lists them with a path to correct and
  resubmit.
- For a rejected **order**, a task is also created against that customer,
  because the salesman stood in the shop and said the order was placed. A
  notification can be missed; a task on the list cannot.

Codes: `credit_blocked` `credit_exceeded` `product_inactive` `price_changed`
`bill_settled` `outstanding_stale` `duplicate` `validation` `not_permitted`.

---

## 7. Conflicts

**Append-only entities cannot conflict.** A visit, order, payment, complaint or
sample created on two devices is two records. Only edits to the same mutable
record conflict: customer details, task state, lead stage.

Resolution is latest-write-wins **on server-received time**, never on device
time — a handset's clock is wrong and its owner can set it.

The losing version goes to `conflict_log` on both sides and the author whose
edit lost is notified. Nothing is discarded silently.

---

## 8. What the server owns

Recomputed server-side after ingest, never trusted from the client:
customer outstanding, health score, order approval state, receipt and order
numbers, and every approval decision. The client's copies are caches with a
`lastSyncedAt`, and any screen where a decision hangs on one shows that time.

## 9. What the client owns

The local store is the truth for the UI. It is **scoped** — the bootstrap only
ever returns this salesman's book, and internal notes are never in the payload
for a Field Sales Executive at all, so a note that could leak is not on the
device to leak.
