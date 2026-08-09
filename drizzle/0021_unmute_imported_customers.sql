-- Lets the imported book back into the calling queue.
--
-- `active_in_order_system` means there is live activity in the external order
-- system, and the queue holds such a customer back — `queue.excludeActive-
-- InOrderSystem` is on by default. The sheet projection set it on every row it
-- touched, which is every customer the first real import created. The effect
-- was total and invisible: the Call Log was empty, and the reason lived in a
-- flag no screen shows.
--
-- The projection no longer writes it. This clears what it already wrote.
--
-- Narrow on purpose. Only customers carrying a SHEET: external code are
-- touched, because those are the ones the projection created and the flag on
-- them can only have come from it. Anything a person set by hand on a customer
-- that did not come from the sheet is left exactly as it is.
--
-- Safe to re-run: it sets false where true, and a second run matches nothing.

update customers
   set active_in_order_system = false,
       updated_at = now()
 where active_in_order_system
   and external_code like 'SHEET:%';
