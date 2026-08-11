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

export const SCHEMA_VERSION = 2;

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
];

/** Tables holding work the salesman authored. A sync never deletes from these. */
export const OWNED_TABLES = [
  'visits', 'orders', 'order_lines', 'payments', 'attendance_days', 'tasks',
  'leads', 'samples', 'complaints', 'expenses', 'leave_requests',
  'competitor_records', 'approvals',
] as const;

/** Tables replaced wholesale by a pull. Safe to clear on sign-out. */
export const REFERENCE_TABLES = [
  'customers', 'products', 'price_list', 'schemes', 'timeline_events',
  'journey_stops', 'leave_balances', 'documents', 'courses', 'notifications',
] as const;
