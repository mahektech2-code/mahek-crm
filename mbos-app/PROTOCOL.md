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
            "config": { }, "notifications": [] }
}
```

One round trip does both directions. A salesman who gets thirty seconds of
signal between two shops should spend it on both, not on a push that leaves the
book stale.

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
