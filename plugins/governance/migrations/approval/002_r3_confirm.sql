-- v2 (Slice L): R3 needs a second, explicit confirmation before it is approved.
-- The first "approve" click only moves `confirm_stage` to 1; the final click must
-- carry the dedicated `confirmed` decision, so a double-click on "approve" can
-- never settle a high-risk approval.
ALTER TABLE approvals ADD COLUMN confirm_stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN confirm_actor TEXT;
ALTER TABLE approvals ADD COLUMN confirm_at TEXT;
