-- THREE WRONG PINS AND THE PIN STOPS WORKING. Four digits is ten thousand
-- guesses, and the account-wide throttle only pauses them for a while; a PIN
-- found by somebody standing at the phone is the floor's whole lock. So the
-- PIN is shut after the third miss and only an SMS code to the person's own
-- mobile opens the account again — and the code leads straight to choosing a
-- new PIN, which is what clears this count.
ALTER TABLE "factory_staff" ADD COLUMN "pin_failures" integer DEFAULT 0 NOT NULL;
