/**
 * The local store.
 *
 * This is the database the UI reads. Not a cache in front of a server — the
 * store. Every screen queries SQLite and nothing awaits the network, which is
 * the whole architectural fact the app is built on: a salesman in a paint
 * market has no usable signal for hours, and an app that pauses for a request
 * is an app he stops using by eleven in the morning.
 *
 * Two kinds of table live here and they behave differently:
 *
 *   REFERENCE data (customers, products, timeline, config) is pulled from
 *   MahekOne and overwritten on each pull. It carries `lastSyncedAt` because a
 *   credit limit read from a four-hour-old cache is a different thing to one
 *   read a minute ago, and the screens that decide on it say which they have.
 *
 *   OWNED data (visits, orders, payments, everything the salesman creates) is
 *   authored here first and pushed. It carries a sync state and is never
 *   deleted by a sync — not when the server rejects it, not when it loses a
 *   conflict.
 */

export const SCHEMA_VERSION = 10;

/**
 * Every statement is idempotent, and migrations are applied in order by
 * `user_version`. A handset that has been offline across two releases must
 * arrive at the same schema as one that took every release in turn.
 */
export const MIGRATIONS: string[][] = [
  /* ---- v1 ------------------------------------------------------------- */
  [
    `PRAGMA journal_mode = WAL;`,
    `PRAGMA foreign_keys = ON;`,

    /* ---------------------------------------------------------- reference */

    `CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contactPerson TEXT,
      phone TEXT,
      city TEXT,
      area TEXT,
      beat TEXT,
      territoryRegion TEXT,
      gstin TEXT,
      dealerCode TEXT,
      customerType TEXT,
      potential TEXT,
      gpsLat REAL,
      gpsLng REAL,
      gpsAccuracyM INTEGER,
      creditLimitPaise INTEGER,
      creditDays INTEGER,
      creditBlocked INTEGER NOT NULL DEFAULT 0,
      creditBlockReason TEXT,
      outstandingPaise INTEGER NOT NULL DEFAULT 0,
      submittedNotInvoicedPaise INTEGER NOT NULL DEFAULT 0,
      healthScore INTEGER,
      healthComponents TEXT,
      lastOrderDate TEXT,
      lastVisitDate TEXT,
      visitFrequencyDays INTEGER,
      cycleDays INTEGER,
      payBehaviour TEXT,
      status TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);`,
    /* Customers with no coordinates have to be findable and countable — the
       brief requires surfacing them so the gap gets closed in the field. */
    `CREATE INDEX IF NOT EXISTS idx_customers_nogps ON customers(gpsLat) WHERE gpsLat IS NULL;`,

    `CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rawName TEXT,
      formulation TEXT,
      brand TEXT,
      finishedGood TEXT,
      packSize TEXT,
      packing TEXT,
      cansPerBox INTEGER,
      millilitresPerCan INTEGER,
      sellingPricePaise INTEGER,
      minOrderCans INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);`,

    /* A rate for this customer's price tag. Empty until a price source is
       confirmed — see `products.priceSource` in MahekOne's config. */
    `CREATE TABLE IF NOT EXISTS price_list (
      priceTag TEXT NOT NULL,
      productId TEXT NOT NULL,
      ratePaise INTEGER NOT NULL,
      PRIMARY KEY (priceTag, productId)
    );`,

    `CREATE TABLE IF NOT EXISTS schemes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      eligibility TEXT NOT NULL,
      benefit TEXT NOT NULL,
      validFrom TEXT,
      validTo TEXT
    );`,

    /* The shared stream. Both apps write it; a telecaller's call has to be
       visible to the salesman walking into the shop an hour later. */
    `CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      eventType TEXT NOT NULL,
      sourceApp TEXT NOT NULL,
      sourceRecordId TEXT,
      occurredAt INTEGER NOT NULL,
      actor TEXT,
      summary TEXT NOT NULL,
      meta TEXT
    );`,
    `CREATE INDEX IF NOT EXISTS idx_timeline_cust ON timeline_events(customerId, occurredAt DESC);`,

    `CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    `CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`,

    /* -------------------------------------------------------------- owned */

    /* Columns shared by every owned table, per the brief's universal rules:
       a client id, both clock readings, the device, and a sync state. */
    `CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      userId TEXT NOT NULL,
      checkInLat REAL, checkInLng REAL, checkInAccuracyM INTEGER, checkInAt INTEGER,
      checkOutLat REAL, checkOutLng REAL, checkOutAccuracyM INTEGER, checkOutAt INTEGER,
      durationSeconds INTEGER,
      outcome TEXT,
      notes TEXT,
      transcript TEXT,
      transcriptIsAi INTEGER NOT NULL DEFAULT 0,
      shopPhotoId TEXT,
      custPhotoId TEXT,
      voiceNoteId TEXT,
      linkedOrderId TEXT,
      linkedPaymentId TEXT,
      linkedComplaintId TEXT,
      linkedSampleId TEXT,
      nextFollowUpDate TEXT,
      journeyStopId TEXT,
      wasPlanned INTEGER NOT NULL DEFAULT 0,
      deviationReason TEXT,
      locationMismatch INTEGER NOT NULL DEFAULT 0,
      metresFromShop INTEGER,
      verified INTEGER NOT NULL DEFAULT 0,
      unverifiedReason TEXT,
      openEnded INTEGER NOT NULL DEFAULT 0,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,
    `CREATE INDEX IF NOT EXISTS idx_visits_cust ON visits(customerId, checkInAt DESC);`,

    `CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      userId TEXT NOT NULL,
      visitId TEXT,
      orderNumber TEXT,
      orderedAt INTEGER NOT NULL,
      deliveryDate TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      paymentTermDays INTEGER,
      subtotalPaise INTEGER,
      discountPaise INTEGER,
      schemeDiscountPaise INTEGER,
      netTotalPaise INTEGER,
      valueUnavailable INTEGER NOT NULL DEFAULT 0,
      approvalId TEXT,
      cancelReason TEXT,
      erpRef TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS order_lines (
      id TEXT PRIMARY KEY,
      orderId TEXT NOT NULL,
      productId TEXT NOT NULL,
      productName TEXT NOT NULL,
      cans INTEGER NOT NULL,
      boxes REAL,
      litres REAL,
      ratePaise INTEGER,
      discountPct REAL,
      schemeApplied TEXT,
      lineTotalPaise INTEGER
    );`,
    `CREATE INDEX IF NOT EXISTS idx_lines_order ON order_lines(orderId);`,

    `CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      userId TEXT NOT NULL,
      visitId TEXT,
      amountPaise INTEGER NOT NULL,
      mode TEXT NOT NULL,
      chequeNumber TEXT,
      bank TEXT,
      chequeDate TEXT,
      chequePhotoId TEXT,
      collectedAt INTEGER NOT NULL,
      receiptNumber TEXT,
      localReceiptRef TEXT NOT NULL,
      receiptSent INTEGER NOT NULL DEFAULT 0,
      receiptChannel TEXT,
      isAdvance INTEGER NOT NULL DEFAULT 0,
      billRefs TEXT,
      deposited INTEGER NOT NULL DEFAULT 0,
      depositedAt INTEGER,
      depositProofId TEXT,
      depositSlaDueAt INTEGER,
      bounced INTEGER NOT NULL DEFAULT 0,
      bouncedAt INTEGER,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS attendance_days (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      day TEXT NOT NULL,
      checkInAt INTEGER, checkInLat REAL, checkInLng REAL, checkInAccuracyM INTEGER,
      checkInSelfieId TEXT,
      withinRadius INTEGER,
      fieldVisitOverride INTEGER NOT NULL DEFAULT 0,
      overrideReason TEXT,
      checkOutAt INTEGER, checkOutLat REAL, checkOutLng REAL,
      workedMinutes INTEGER,
      status TEXT,
      autoMarked INTEGER NOT NULL DEFAULT 0,
      regularizationId TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_att_day ON attendance_days(userId, day);`,

    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      assigneeId TEXT,
      assignerId TEXT,
      priority TEXT NOT NULL DEFAULT 'Normal',
      dueDate TEXT NOT NULL,
      customerId TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      completionNote TEXT,
      completionPhotoId TEXT,
      snoozeHistory TEXT,
      escalated INTEGER NOT NULL DEFAULT 0,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT,
      mobile TEXT,
      city TEXT,
      source TEXT,
      estimatedPotentialPaise INTEGER,
      assigneeId TEXT,
      stage TEXT NOT NULL DEFAULT 'New',
      nextFollowUpDate TEXT,
      notes TEXT,
      convertedCustomerId TEXT,
      lostReason TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      lastActivityDate TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS samples (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      productId TEXT,
      productName TEXT,
      cans INTEGER,
      reason TEXT,
      requestedAt INTEGER NOT NULL,
      approvalId TEXT,
      state TEXT NOT NULL DEFAULT 'Requested',
      deliveredAt INTEGER,
      deliveryPhotoId TEXT,
      trialOutcome TEXT,
      followUpDate TEXT,
      convertedOrderId TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      visitId TEXT,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      photoIds TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      spentOn TEXT NOT NULL,
      category TEXT NOT NULL,
      amountPaise INTEGER NOT NULL,
      billPhotoId TEXT,
      remarks TEXT,
      claimId TEXT,
      state TEXT NOT NULL DEFAULT 'Pending',
      approvedAmountPaise INTEGER,
      rejectionReason TEXT,
      tourId TEXT,
      rolledOverFrom TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS leave_requests (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      kind TEXT NOT NULL,
      fromDate TEXT NOT NULL,
      toDate TEXT NOT NULL,
      halfDay TEXT,
      days REAL NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'Pending',
      lossOfPay INTEGER NOT NULL DEFAULT 0,
      balanceSnapshot TEXT,
      approvalId TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS leave_balances (
      kind TEXT PRIMARY KEY,
      entitled REAL NOT NULL,
      used REAL NOT NULL,
      available REAL NOT NULL,
      period TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    /*
     * His own month, as the office scored it.
     *
     * PURE REFERENCE, and one of the few tables here the handset can only
     * read: nothing on this phone may write a target or a score, which is the
     * same rule the office screens enforce and for the same reason — a
     * salesman who can edit what he is measured against is not being measured.
     *
     * `computedAt` is on the row and the screen prints it. The figures are a
     * cache the office rebuilds, so they are minutes to an hour old rather
     * than live, and a screen that implied otherwise would be read as live.
     */
    `CREATE TABLE IF NOT EXISTS performance (
      period TEXT PRIMARY KEY,
      revenueTargetPaise INTEGER,
      revenueActualPaise INTEGER,
      revenueAchievementBp INTEGER,
      volumeTargetMl INTEGER,
      volumeActualMl INTEGER,
      volumeAchievementBp INTEGER,
      mixAchievementBp INTEGER,
      newCustomerTarget INTEGER,
      newCustomerActual INTEGER,
      collectionTargetPaise INTEGER,
      collectionActualPaise INTEGER,
      activityTarget INTEGER,
      activityActual INTEGER,
      totalScoreBp INTEGER,
      rating TEXT,
      untargeted TEXT,
      unmatchedRevenuePaise INTEGER,
      categories TEXT,
      computedAt TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    `CREATE TABLE IF NOT EXISTS competitor_records (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      visitId TEXT,
      competitorName TEXT NOT NULL,
      ratePaise INTEGER,
      rateNote TEXT,
      creditTerms TEXT,
      delivery TEXT,
      strengths TEXT,
      weaknesses TEXT,
      capturedAt INTEGER NOT NULL,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS journey_stops (
      id TEXT PRIMARY KEY,
      planDate TEXT NOT NULL,
      customerId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      plannedAt TEXT,
      actualAt INTEGER,
      visitId TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      skipReason TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_stops_day ON journey_stops(planDate, seq);`,

    `CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subjectType TEXT NOT NULL,
      subjectId TEXT NOT NULL,
      reason TEXT,
      requestedAt INTEGER NOT NULL,
      approverName TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      decidedAt INTEGER,
      decisionNote TEXT,
      approvedAmountPaise INTEGER,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'neutral',
      href TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      readAt INTEGER,
      createdAt INTEGER NOT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      kind TEXT,
      sizeLabel TEXT,
      remoteRef TEXT,
      localUri TEXT,
      availableOffline INTEGER NOT NULL DEFAULT 0,
      expiresOn TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    `CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      kind TEXT,
      minutes INTEGER,
      mandatory INTEGER NOT NULL DEFAULT 0,
      deadline TEXT,
      completedAt INTEGER,
      quizScore INTEGER,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    /* --------------------------------------------------------- the outbox */

    /* Ordering is by dependency, not by creation time. An item whose
       dependencies are not yet `synced` is not eligible however old it is. */
    `CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      op TEXT NOT NULL,
      payload TEXT NOT NULL,
      dependsOn TEXT NOT NULL DEFAULT '[]',
      idempotencyKey TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lastAttemptAt INTEGER,
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'queued',
      failureCode TEXT,
      failureReason TEXT,
      createdAt INTEGER NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_queue_ready ON sync_queue(state, nextAttemptAt);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_idem ON sync_queue(idempotencyKey);`,

    /* Media is queued separately. 840 KB of shop photographs must never be
       the reason a payment sits unsent. */
    `CREATE TABLE IF NOT EXISTS media_queue (
      id TEXT PRIMARY KEY,
      parentType TEXT NOT NULL,
      parentId TEXT NOT NULL,
      kind TEXT NOT NULL,
      localUri TEXT NOT NULL,
      mimeType TEXT,
      bytes INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'queued',
      remoteRef TEXT,
      failureReason TEXT,
      /* Audio is kept until its transcription is confirmed stored. Dropping it
         earlier loses the only copy of what the customer actually said. */
      transcriptionState TEXT,
      createdAt INTEGER NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_media_ready ON media_queue(state, nextAttemptAt);`,

    `CREATE TABLE IF NOT EXISTS conflict_log (
      id TEXT PRIMARY KEY,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      localVersion TEXT NOT NULL,
      serverVersion TEXT NOT NULL,
      resolution TEXT NOT NULL,
      reviewed INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );`,
  ],

  /* ---- v2 · a working day is SESSIONS, not one pair of timestamps ------ */
  [
    /*
     * A salesman breaks for lunch, or goes home and comes out again for an
     * evening call. Holding one `checkInAt`/`checkOutAt` meant the second
     * check-in cleared the first check-out, and 9-to-1 plus 2-to-6 came out as
     * nine hours instead of eight — an hour of unworked time on a record that
     * feeds a payslip.
     *
     * `sessions` is the truth now: `[{ inAt, outAt }]`, oldest first, with at
     * most one open. `checkInAt` and `checkOutAt` stay as the first-in and
     * last-out of the day, because that is what the screens show and what the
     * office asks for, but nothing computes hours from them any more.
     */
    `ALTER TABLE attendance_days ADD COLUMN sessions TEXT NOT NULL DEFAULT '[]';`,

    /* Days recorded before this carry their single pair across, so nobody's
       existing history reads as zero hours after an update. */
    `UPDATE attendance_days
        SET sessions = json_array(json_object('inAt', checkInAt, 'outAt', checkOutAt))
      WHERE sessions = '[]' AND checkInAt IS NOT NULL;`,
  ],

  /* ---- v3 ------------------------------------------------------------- */
  [
    /*
     * A day is AGREED, not issued.
     *
     * The office proposes a city; this handset answers. Until now the only
     * thing that came down was a stop, and a stop exists only once a day is
     * already planned — so a month laid out in advance was invisible here, and
     * the first the salesman knew of a day was a route he had never been asked
     * about.
     *
     * `picked` is how many shops he has chosen. It is a count from the server
     * rather than a join on `journey_stops`, because a day can be agreed with
     * no stops yet and the difference between "none picked" and "not planned"
     * is the whole state machine.
     */
    `CREATE TABLE IF NOT EXISTS journey_days (
      id TEXT PRIMARY KEY,
      planDate TEXT NOT NULL,
      city TEXT,
      beat TEXT,
      dayState TEXT NOT NULL DEFAULT 'proposed',
      refusalReason TEXT,
      counterCity TEXT,
      proposedAt INTEGER,
      proposedBy TEXT,
      picked INTEGER NOT NULL DEFAULT 0,
      syncState TEXT NOT NULL DEFAULT 'synced',
      syncMessage TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_days_date ON journey_days(planDate);`,
  ],

  /* ---- v4 ------------------------------------------------------------- */
  [
    /*
     * The trail.
     *
     * Where somebody actually went, while they were working. Two fixes a day —
     * the check-in and each visit — is not a track, and a map drawn from them
     * would look like tracking without being it.
     *
     * It is NOT in the outbox, and that is the point. The outbox is
     * dependency-ordered and retries for ever, because a visit that never
     * arrives is a call nobody has a record of. A position is the opposite
     * kind of thing: one of a hundred, worth nothing on its own, and a
     * position lost is a slightly coarser line on a map. Retrying them through
     * the same machinery would put a hundred rows a day in front of the visit
     * behind them, on a 2G connection, for no gain.
     *
     * So they queue here, go up in batches, and are DELETED once acknowledged.
     * Sent-but-unacknowledged is the only state worth having.
     */
    `CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracyM INTEGER,
      sentAt INTEGER
    );`,
    `CREATE INDEX IF NOT EXISTS idx_positions_at ON positions(at);`,
  ],

  /* ---- v5 ------------------------------------------------------------- */
  [
    /*
     * Where each thing was done.
     *
     * A SIBLING of the payload rather than a field inside it, and that is the
     * whole reason it is a column here instead: `idempotencyKey` is a hash of
     * the payload, so folding a position into it would make the same order
     * enqueued twice from two spots on a street into two orders. Where
     * somebody was standing is a fact about the act, not part of the record.
     */
    `ALTER TABLE sync_queue ADD COLUMN location TEXT;`,
  ],

  /* ---- v6 ------------------------------------------------------------- */
  [
    /*
     * Who we BILL for this shop, as opposed to who receives the goods.
     *
     * Two questions with different answers on a shop served through a
     * distributor, and the server has held both since `orders` grew a delivery
     * party. What was missing was anybody asking at the point of order — so
     * these two columns are what let the handset ask it offline.
     *
     * `thirdParty` is the mark: goods come here, the invoice does not.
     * `distributors` is a JSON array of who the invoice goes to instead, and
     * it is an ARRAY because a shop on a territory boundary is served by two;
     * storing one would make the other unrecordable, which is wrong for
     * exactly the shops that most need it recorded. The generic upsert already
     * writes whatever the server sends and already turns an array into JSON,
     * so nothing in `sync/pull.ts` had to learn about either of these — the
     * columns simply have to exist or the insert fails on an unknown column.
     *
     * Reference data, not permission. The billing party still has to be a
     * customer in this salesman's own book: that is whose credit limit, term
     * and outstanding decide whether the order can be taken. What this buys is
     * that the handset can SAY SO while he is standing in the shop, instead of
     * the order being refused at sync hours later with nothing explaining why.
     */
    /*
     * NOT added to the v1 CREATE beside this, deliberately. Every migration
     * runs in order on a fresh install too, so a column declared in both would
     * make v6 fail on a duplicate — `sync_queue.location` and
     * `attendance_days.sessions` are here for the same reason and neither is
     * in its own CREATE either. The v1 statements are the schema as it was,
     * not the schema as it is.
     */
    `ALTER TABLE customers ADD COLUMN thirdParty INTEGER NOT NULL DEFAULT 0;`,
    `ALTER TABLE customers ADD COLUMN distributors TEXT NOT NULL DEFAULT '[]';`,
    /*
     * Where the goods went, when that is not where the bill went.
     *
     * `customerId` on an order is who we INVOICE and stays the account every
     * figure is read from. This is the shop the lorry stops at. NULL means the
     * billing party received them, which is the ordinary case and what every
     * order taken before the form learned to ask means — so nothing had to be
     * rewritten and no stored order changed meaning.
     */
    `ALTER TABLE orders ADD COLUMN deliveryCustomerId TEXT;`,
  ],

  /* ---- v7 · a calendar the attendance engine can actually read ---------- */
  [
    /*
     * Why attendance ran `isWorkingDay: true` on every single day: there was
     * nothing here to say otherwise. The office has maintained a real holiday
     * calendar for a while — it just never reached the phone.
     *
     * `universal` is the server's own judgement, not this table's: a holiday
     * with a free-text `scope` ("Nagpur East and Nagpur West") cannot be
     * matched against a salesman's own territory on this side, so only a
     * `universal` row (the server sent `scope: null`) is safe for the
     * attendance engine to act on automatically. A scoped one is still stored
     * and still listed, it just does not flip a day to Weekly Off on its own.
     */
    `CREATE TABLE IF NOT EXISTS holidays (
      id TEXT PRIMARY KEY,
      onDate TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT,
      universal INTEGER NOT NULL DEFAULT 0,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS holidays_date_idx ON holidays(onDate);`,
  ],

  /* ---- v8 · the join price_list was always missing ---------------------- */
  [
    /*
     * price_list is keyed on priceTag + productId — see `upsertPriceList` —
     * and until now no local column said which tag a given customer pays at.
     * The rate existed, the tag existed, and nothing joined them, so the
     * order form had a price list it could never actually look anything up
     * in.
     */
    `ALTER TABLE customers ADD COLUMN priceTag TEXT;`,
    /*
     * The server's own scheme row has always carried a description
     * (`schemeRows()` selects it) and this table never had anywhere to put
     * one — so the generic upsert in `sync/pull.ts` would have failed on
     * "no such column: description" the moment any scheme actually had one.
     * Nothing caught it before now because nothing had ever populated
     * `mbos_schemes` with a description to pull.
     */
    `ALTER TABLE schemes ADD COLUMN description TEXT;`,
  ],

  /* ---- v9 · a door onto mbos_tours, which had none ----------------------- */
  [
    /*
     * `mbos_tours` existed server-side with a real approval type
     * (`mbosApprovalTypeEnum` has carried "tour" since the enum was written)
     * and zero code anywhere ever created one. This is that door: asking to
     * work away from the usual beat for several days, the same shape as
     * `leave_requests` and gated by the same generic approval channel.
     */
    `CREATE TABLE IF NOT EXISTS tours (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      startDate TEXT NOT NULL,
      endDate TEXT NOT NULL,
      cities TEXT NOT NULL DEFAULT '[]',
      purpose TEXT,
      estimatedCostPaise INTEGER,
      notes TEXT,
      state TEXT NOT NULL DEFAULT 'Pending',
      decisionNote TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,
  ],

  /* ---- v10 · the salary channel the salary screen never had -------------- */
  [
    /*
     * `app/salary.tsx` used to render a fully invented payslip and was
     * rewritten to a stub admitting no channel carried real figures. This is
     * that channel arriving — same shape as `performance`, keyed by period,
     * replaced wholesale by the generic upsert on every pull.
     */
    `CREATE TABLE IF NOT EXISTS salary (
      period TEXT PRIMARY KEY,
      employeeCode TEXT,
      employeeStatus TEXT,
      netSalaryPaise INTEGER,
      conveyancePaise INTEGER,
      otherSalaryPaise INTEGER,
      pfEsicApplicable INTEGER,
      dateOfJoining TEXT,
      daysWorked INTEGER,
      daysOnLeave INTEGER,
      reimbursedPaise INTEGER,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
  ],
];

/** Tables holding work the salesman authored. A sync never deletes from these. */
export const OWNED_TABLES = [
  'visits', 'orders', 'order_lines', 'payments', 'attendance_days', 'tasks',
  'leads', 'samples', 'complaints', 'expenses', 'leave_requests', 'tours',
  'competitor_records', 'approvals',
] as const;

/** Tables replaced wholesale by a pull. Safe to clear on sign-out. */
export const REFERENCE_TABLES = [
  'customers', 'products', 'price_list', 'schemes', 'timeline_events',
  'journey_stops', 'leave_balances', 'holidays', 'documents', 'courses',
  'notifications', 'performance', 'salary',
  /*
   * `journey_days` is here, and it is the awkward one.
   *
   * The office owns the day and the salesman owns his answer to it, so it is
   * neither purely reference nor purely owned. It is cleared on sign-out
   * because the answer is on the SERVER the moment it syncs — a refusal that
   * has not synced is in the outbox, which survives, and one that has is
   * already the office's record.
   */
  'journey_days',
] as const;
