-- An LR may be uploaded with nothing but its photograph: logistics reads the
-- number off it on the LR desk, and an LR still needs one before it is attached.
ALTER TABLE "erp_lrs" ALTER COLUMN "lr_no" DROP NOT NULL;
