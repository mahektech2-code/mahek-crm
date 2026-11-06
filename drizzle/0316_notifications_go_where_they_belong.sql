-- Each web app's bell shows its own work, and the phone gets the phone's.
--
-- A notification's destination is read from its two links. A row with neither
-- counted as general and was drawn in every app, which is where most of these
-- were never meant to be. A link to /field opened nothing: the Salesman App has
-- no web screens. Titles are matched because the writers that made these rows
-- are the only record of who they were for.

-- What each phone has answered about notifications, for the office to see.
ALTER TABLE "mbos_devices" ADD COLUMN IF NOT EXISTS "notification_permission" text;
--> statement-breakpoint
UPDATE "notifications" SET "mbos_href" = COALESCE("mbos_href", '/tasks'), "href" = NULL WHERE "href" = '/field/tasks';
--> statement-breakpoint
UPDATE "notifications" SET "mbos_href" = COALESCE("mbos_href", '/notifications'), "href" = NULL WHERE "href" = '/field' OR "href" LIKE '/field/%' OR "href" = '/journey';
--> statement-breakpoint
UPDATE "notifications" SET "mbos_href" = COALESCE("mbos_href", '/notifications'), "href" = NULL WHERE "href" = '/apps' AND ("title" LIKE 'Your attendance%' OR "title" LIKE 'Your odometer%');
--> statement-breakpoint
UPDATE "notifications" SET "href" = '/sales/leave', "mbos_href" = '/notifications'
WHERE COALESCE("href", '') = '' AND COALESCE("mbos_href", '') = ''
  AND ("title" = 'Leave requested' OR "title" LIKE '% withdrew%');
--> statement-breakpoint
UPDATE "notifications" SET "href" = '/sales/journeys', "mbos_href" = '/notifications'
WHERE COALESCE("href", '') = '' AND COALESCE("mbos_href", '') = ''
  AND ("title" LIKE '% planned %' OR "title" LIKE '% agreed %' OR "title" LIKE '% cannot work %' OR "title" = 'Asked for different cities');
--> statement-breakpoint
UPDATE "notifications" SET "href" = '/crm/leads', "mbos_href" = '/notifications'
WHERE COALESCE("href", '') = '' AND COALESCE("mbos_href", '') = ''
  AND ("title" LIKE '% was moved' OR "title" LIKE '% moved' OR "title" LIKE '% was archived' OR "title" LIKE '% archived' OR "title" LIKE 'A lead was assigned to you%' OR "title" LIKE '% is now yours' OR "title" LIKE '% are now yours' OR "title" LIKE 'Chase — %');
--> statement-breakpoint
UPDATE "notifications" SET "mbos_href" = '/notifications'
WHERE COALESCE("href", '') = '' AND COALESCE("mbos_href", '') = ''
  AND ("title" LIKE 'Holiday:%' OR "title" LIKE '%is a work%' OR "title" LIKE 'Your route for%' OR "title" LIKE '% proposed for you'
    OR "title" LIKE 'Your attendance%' OR "title" LIKE 'Your odometer%' OR "title" LIKE 'Your leave request%' OR "title" LIKE 'A task was assigned%' OR "title" = 'Punch in'
    OR "title" IN ('Your handset was released', 'Where you work has changed', 'Your handset has no area set', 'Your patch has changed', 'You now cover all of India', 'Your expense policy changed', 'A question about a visit'));
