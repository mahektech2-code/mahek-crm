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

  /* ---------------------------------------------------------- migration 5
   * Travel, the day, and the policy the day is priced against.
   *
   * `expense_policy` is ONE ROW — a whole policy as JSON, replaced wholesale
   * on every pull. It is not normalised into rules, and deliberately: the
   * engine takes a Policy object, the wire sends one, and a schema in between
   * would be a third vocabulary to keep in step with the other two. It is a
   * few kilobytes.
   * ------------------------------------------------------------------- */
  [
    `CREATE TABLE IF NOT EXISTS expense_days (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      day TEXT NOT NULL,
      departedAt INTEGER,
      returnedAt INTEGER,
      departedFromHometown INTEGER NOT NULL DEFAULT 1,
      destinationCity TEXT,
      arrivedAtDestinationAt INTEGER,
      overnight INTEGER NOT NULL DEFAULT 0,
      stayedInHotel INTEGER NOT NULL DEFAULT 0,
      openingOdometerKm INTEGER,
      closingOdometerKm INTEGER,
      odometerPhotoDemanded INTEGER NOT NULL DEFAULT 0,
      submittedAt INTEGER,
      lockedAt INTEGER,
      note TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS expense_days_day ON expense_days (userId, day);`,

    `CREATE TABLE IF NOT EXISTS travel_legs (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      expenseDayId TEXT,
      day TEXT,
      modeKey TEXT NOT NULL,
      fromLabel TEXT,
      toLabel TEXT,
      fromLat REAL, fromLng REAL, toLat REAL, toLng REAL,
      startedAt INTEGER,
      endedAt INTEGER,
      purpose TEXT,
      customerId TEXT,
      visitId TEXT,
      manualMetres INTEGER,
      manualReason TEXT,
      odometerStartKm INTEGER,
      odometerEndKm INTEGER,
      odometerPhotoId TEXT,
      ticketAmountPaise INTEGER,
      ticketPhotoId TEXT,
      ticketReference TEXT,
      note TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,
    `CREATE INDEX IF NOT EXISTS travel_legs_day ON travel_legs (expenseDayId);`,

    /* Reference. Replaced by a pull, cleared on sign-out. */
    `CREATE TABLE IF NOT EXISTS travel_modes (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      reimbursementKind TEXT NOT NULL,
      requiresOdometer INTEGER NOT NULL DEFAULT 0,
      requiresTicket INTEGER NOT NULL DEFAULT 0,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    `CREATE TABLE IF NOT EXISTS expense_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      policyId TEXT NOT NULL,
      versionNo INTEGER NOT NULL,
      effectiveFrom TEXT NOT NULL,
      effectiveTo TEXT,
      grade TEXT,
      cityClass TEXT,
      rulesJson TEXT NOT NULL,
      sentencesJson TEXT NOT NULL,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    /* What the office questioned, so the handset can say why a day is waiting
       rather than leaving the salesman to guess. */
    `CREATE TABLE IF NOT EXISTS expense_exceptions (
      id TEXT PRIMARY KEY,
      expenseDayId TEXT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      salesmanReason TEXT,
      resolution TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,

    /* The policy module's columns on the expense the salesman types. */
    `ALTER TABLE expenses ADD COLUMN kind TEXT;`,
    `ALTER TABLE expenses ADD COLUMN expenseDayId TEXT;`,
    `ALTER TABLE expenses ADD COLUMN eligiblePaise INTEGER;`,
    `ALTER TABLE expenses ADD COLUMN excessPaise INTEGER;`,
    `ALTER TABLE expenses ADD COLUMN vendorName TEXT;`,
    `ALTER TABLE expenses ADD COLUMN billNumber TEXT;`,
    `ALTER TABLE expenses ADD COLUMN exceptionReason TEXT;`,
  ],

  /* ---- v12 · a position is its reading, so a redelivery is not a new row -- */
  [
    /*
     * The trail queue had `id TEXT PRIMARY KEY` and nothing else unique, and
     * every id was a fresh UUID — so `INSERT OR IGNORE` had nothing to ignore
     * on. Android redelivers a batch of deferred locations whenever the task
     * does not complete, and each redelivery became a new row: production
     * carried 33,000 rows for 4,000 real fixes, one of them ninety-three times.
     *
     * The duplicates are collapsed FIRST — a unique index cannot be created
     * over a table that already violates it, and a migration that throws here
     * would strand the handset for ever. `MIN(rowid)` keeps the copy that
     * arrived first, which is the one already ordered against its neighbours.
     *
     * This is also what unblocks the phones already in the field. The queue
     * drains OLDEST FIRST, so a backlog of duplicates is precisely what stood
     * between a salesman's current position and the Live map — one handset was
     * thousands of rows behind, all of them copies of a previous evening.
     * Collapsing it on first launch means the next flush sends today, without
     * anybody being asked to do anything.
     */
    `DELETE FROM positions
      WHERE rowid NOT IN (SELECT MIN(rowid) FROM positions GROUP BY at, lat, lng);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_fix ON positions(at, lat, lng);`,
  ],

  /* ---- v12 · is this a shop or somebody we hope will become one? -------- */
  [
    /*
     * `kind` was on the wire from the first MBOS commit and had nowhere to
     * land, so it was dropped from the payload when the two sides were
     * reconciled. It is wanted now: this list holds LEADS as well as
     * customers — a lead reaches it through `owner_id` — and a card that does
     * not say which is which asks the salesman to remember, per row.
     */
    `ALTER TABLE customers ADD COLUMN kind TEXT;`,
  ],

  /* ---- v13 · what the office knows this shop bought and paid ------------ */
  [
    /*
     * THE RECORD'S HISTORY TABS WERE PLACEHOLDERS — "Next to build" — and the
     * obvious cheap fix was to render them off `timeline_events`, which already
     * syncs. Production says no: 10,874 orders against 61 order events, and
     * 18,414 receipts against 271 payment events. A tab built that way would
     * show one order to a salesman standing in a shop that has placed forty,
     * and be believed. Better a placeholder than a screen that lies.
     *
     * So the office's history gets its own channel and its own tables.
     *
     * NOT `orders` and `payments`. Those are OWNED — the salesman authors them,
     * they carry `syncState` and they feed the outbox — and a sync writing into
     * them would put the office's rows in the queue that sends his. These are
     * reference: read-only here, replaced by the pull, cleared on sign-out.
     */
    `CREATE TABLE IF NOT EXISTS customer_orders (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      orderedAt TEXT,
      status TEXT,
      valuePaise INTEGER,
      lines INTEGER,
      orderNo TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_customer_orders_cust
       ON customer_orders(customerId, orderedAt DESC);`,

    `CREATE TABLE IF NOT EXISTS customer_payments (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      receivedAt TEXT,
      amountPaise INTEGER,
      mode TEXT,
      reference TEXT,
      status TEXT,
      lastSyncedAt INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_customer_payments_cust
       ON customer_payments(customerId, receivedAt DESC);`,
  ],

  /* ---- v14 · a lead has a place, and somebody running it ----------------- */
  [
    /*
     * THE SERVER HAS BEEN SENDING THESE ALL ALONG.
     *
     * `openLeads` selects `gps_lat` and `gps_lng` on every bootstrap and every
     * delta, and this table had nowhere to put them — so `upsert` dropped both
     * columns on arrival, silently, exactly as it is designed to. That is the
     * right trade in general: a field the screens cannot read costs nothing,
     * and refusing the row would cost the book. Here it cost the one thing a
     * lead map is made of. Every lead this handset holds has a coordinate on
     * the server and none on the phone.
     *
     * Nothing else had to change for these to start landing. The generic
     * upsert writes whatever it recognises; recognising it is the whole fix.
     */
    `ALTER TABLE leads ADD COLUMN gpsLat REAL;`,
    `ALTER TABLE leads ADD COLUMN gpsLng REAL;`,
    /*
     * Who is running the conversion, once a lead is qualified.
     *
     * The salesman keeps the lead — it is still his to visit and it stays in
     * his book — so this is read as information rather than as ownership. It
     * is here so the card can say WHO to ring about a commercial question,
     * offline, which is the only moment the answer is worth anything.
     */
    `ALTER TABLE leads ADD COLUMN leadManagerId TEXT;`,
    `ALTER TABLE leads ADD COLUMN leadManagerName TEXT;`,
  ],

  /* ---- v15 · what the salesman actually learns in the shop --------------- */
  [
    /*
     * §A and §C of the brief. The form asked for a name, a company, a mobile,
     * a town and a guess at the money; these are the nine other things a
     * salesman finds out while he is standing there, and had nowhere to write.
     *
     * `monthlyVolumeLitres` is LITRES and not cans, which is the one place
     * this app departs from "a quantity is cans". There is no SKU at capture —
     * a prospect says "about two hundred litres a month" before anybody knows
     * what pack they will buy it in — so cans would be a unit nobody has
     * agreed the size of.
     */
    `ALTER TABLE leads ADD COLUMN address TEXT;`,
    `ALTER TABLE leads ADD COLUMN customerType TEXT;`,
    `ALTER TABLE leads ADD COLUMN gstin TEXT;`,
    `ALTER TABLE leads ADD COLUMN requirement TEXT;`,
    `ALTER TABLE leads ADD COLUMN monthlyVolumeLitres INTEGER;`,
    `ALTER TABLE leads ADD COLUMN decisionMaker TEXT;`,
    /*
     * The shop front. An `attachments` id, never a path — the file goes up the
     * media queue AFTER this row, exactly like a visit's shop photo, so this
     * names a file whose bytes may still be on the phone.
     */
    `ALTER TABLE leads ADD COLUMN shopPhotoId TEXT;`,
    /*
     * A competitor, captured at the lead rather than only on a visit.
     *
     * The office holds this properly in `mbos_competitor_records`, with a
     * price, credit days, strengths and weaknesses. Asking for all of that
     * outside a shop with the customer waiting is how none of it gets typed —
     * so the lead form asks the one question worth asking cold, and the visit
     * form asks the rest.
     */
    `ALTER TABLE leads ADD COLUMN competitorName TEXT;`,
  ],

  /* ---- v16 · a Suspect cannot be visited for ever ----------------------- */
  [
    /*
     * How many times anybody has stood in this shop, as the server counts it.
     *
     * Not derived on the handset: this phone holds only the visits IT authored
     * — there is no visits channel on the pull — so after a reinstall, or for a
     * lead somebody else has been to, a local count would read zero and the cap
     * would never fire. The office counts, the handset adds whatever it has not
     * managed to send yet, and that sum is the honest answer offline.
     */
    `ALTER TABLE leads ADD COLUMN visitCount INTEGER NOT NULL DEFAULT 0;`,
    /*
     * Why a held or stuck lead is not moving. One column for two questions
     * that are the same question — see `customers.lead_hold_reason`.
     */
    `ALTER TABLE leads ADD COLUMN holdReason TEXT;`,
  ],

  /* ---- v17 · the validation call, and the script it is made from -------- */
  [
    /*
     * §E. Its own table rather than columns on `leads`, for the reason the
     * server gives at length: what the salesman was told and what the office
     * was told on the phone are two readings of one shop, and the difference
     * between them is the only thing this call produces that nothing else
     * could. Writing the second over the first destroys exactly that.
     */
    `CREATE TABLE IF NOT EXISTS lead_validations (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL,
      calledAt INTEGER NOT NULL,
      reached INTEGER NOT NULL DEFAULT 1,
      productFeedback TEXT,
      qualityFeedback TEXT,
      dispatchFeedback TEXT,
      salesmanFeedback TEXT,
      confirmedRequirement TEXT,
      confirmedMonthlyVolumeLitres INTEGER,
      confirmedCompetitor TEXT,
      confirmedPotentialPaise INTEGER,
      verdict TEXT NOT NULL DEFAULT 'pending',
      verdictReason TEXT,
      notes TEXT,
      taskId TEXT,
      clientCreatedAt INTEGER NOT NULL,
      serverCreatedAt INTEGER,
      deviceId TEXT NOT NULL,
      syncState TEXT NOT NULL DEFAULT 'local',
      syncMessage TEXT
    );`,
    `CREATE INDEX IF NOT EXISTS idx_lead_val_cust ON lead_validations(customerId, calledAt DESC);`,
    /*
     * WHY a task exists, which the handset had no way to know.
     *
     * The server has sent `sourceType`/`sourceId` on every task since the
     * rejected-order rule was written, and `upsertTasks` — a hand-rolled
     * handler that types its columns out — never read them, so they were
     * dropped in silence. Harmless while every task was just a line of text;
     * not harmless now, because a validation call and a requirement visit are
     * tasks that have to OPEN something, and a task list with no idea what kind
     * of work a row is can only ever show its title.
     */
    `ALTER TABLE tasks ADD COLUMN sourceType TEXT;`,
    `ALTER TABLE tasks ADD COLUMN sourceId TEXT;`,
  ],

  /* ---- v18 · a sample, from the lorry to the verdict -------------------- */
  [
    /*
     * §I, §J and §K. Three dates rather than one, because they are three
     * assertions by three different parties and no two are the same fact:
     * `dispatchedAt` is us saying it went, `deliveredAt` is the carrier or our
     * own man saying it arrived, and `receivedAt` is the SHOP saying it is in
     * their hands. §J turns entirely on the third — "sample received Yes/No; if
     * No the follow-up remains pending" — and it is never defaulted from the
     * second, because a default would quietly assert something nobody asked
     * the customer.
     *
     * It is the same discipline `payment_receipts` keeps for money, one module
     * over.
     */
    `ALTER TABLE samples ADD COLUMN dispatchedAt INTEGER;`,
    `ALTER TABLE samples ADD COLUMN courierName TEXT;`,
    `ALTER TABLE samples ADD COLUMN trackingNumber TEXT;`,
    `ALTER TABLE samples ADD COLUMN receivedAt INTEGER;`,
    /* The gap between these two IS the review window. A trial started and never
       finished is the commonest way a sample goes quiet, and it is invisible
       where the only column is an outcome. */
    `ALTER TABLE samples ADD COLUMN trialStartedAt INTEGER;`,
    `ALTER TABLE samples ADD COLUMN trialCompletedAt INTEGER;`,
    `ALTER TABLE samples ADD COLUMN satisfaction TEXT;`,
    `ALTER TABLE samples ADD COLUMN additionalRequirement TEXT;`,
    `ALTER TABLE samples ADD COLUMN rejectionReason TEXT;`,
  ],
];

/**
 * DERIVED, never typed.
 *
 * It was a literal, and it drifted: the travel and expense module added an
 * eleventh block and left the constant at 10, so `migrate()`'s own
 * `current >= SCHEMA_VERSION` guard returned before running it. A FRESH install
 * was fine — it starts at 0 and runs everything — which is exactly why nobody
 * saw it. Every handset that already had the app sat at `user_version = 10`,
 * skipped the block, and had no travel tables at all.
 *
 * A version that counts the migrations cannot disagree with them. Adding a
 * block is now the whole of adding a migration.
 */
export const SCHEMA_VERSION = MIGRATIONS.length;


/** Tables holding work the salesman authored. A sync never deletes from these. */
export const OWNED_TABLES = [
  'visits', 'orders', 'order_lines', 'payments', 'attendance_days', 'tasks',
  'leads', 'samples', 'complaints', 'expenses', 'leave_requests', 'tours',
  'competitor_records', 'approvals',
  /* The day and its legs are his work, not the office's — a pull must never
     delete a leg he recorded in a market and has not sent yet. */
  'expense_days', 'travel_legs',
] as const;

/** Tables replaced wholesale by a pull. Safe to clear on sign-out. */
export const REFERENCE_TABLES = [
  'customers', 'products', 'price_list', 'schemes', 'timeline_events',
  'journey_stops', 'leave_balances', 'holidays', 'documents', 'courses',
  'notifications', 'performance', 'salary',
  'customer_orders', 'customer_payments',
  /* The policy and the modes are the office's, wholly. `expense_exceptions`
     is too: they are the office's questions about his day, and a question he
     has already answered comes back answered rather than being kept here. */
  'travel_modes', 'expense_policy', 'expense_exceptions',
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
