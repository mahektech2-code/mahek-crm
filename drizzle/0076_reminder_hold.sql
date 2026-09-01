-- A telecaller's decision, not an inference: while a pending reminder holds
-- this and its due date is still ahead, the queue engine holds off
-- order/cycle reasons that would otherwise put the customer back on a Call
-- Log before the promised date. Defaults false, so nothing changes for any
-- reminder written before this existed.
ALTER TABLE "reminders" ADD COLUMN "hold_other_reasons_until_due" boolean NOT NULL DEFAULT false;
