-- DOWNGRADE for 20260827064916_preticket_mint_states
-- Reverts: PreTicketStatus enum (MINTING/MINTED/LINKED), DistributionStatus enum
-- (PARTIALLY_MINTED), PreTicket columns (recipientUserId, mintedAt, lastMintError,
-- emailSentAt), DistributionJob.mintMode, 2 composite indexes.
--
-- KHÔNG chạy tự động — rehearsed script, chạy tay sau khi đã xem dữ liệu (PLAN T4.4,
-- DESIGN muc 1.2). Trinh tu chay tren dev/staging:
--   1. docker exec -i ticket-mayo-db psql -U postgres -d ticket_mayo \
--        < prisma/migrations/20260827064916_preticket_mint_states/downgrade.sql
--   2. Danh dau da rollback trong _prisma_migrations. LUU Y (verified tren dev):
--      `npx prisma migrate resolve --rolled-back ...` chi chay khi migration o
--      trang thai FAILED (loi P3012 neu migration da apply sach). Neu da apply sach:
--        docker exec -i ticket-mayo-db psql -U postgres -d ticket_mayo \
--          -c "DELETE FROM _prisma_migrations WHERE migration_name = '20260827064916_preticket_mint_states';"
--      (sau do `npx prisma migrate status` se thay migration nay chua apply;
--       KHONG chay `migrate dev` lai truoc khi muon — no se apply lai upgrade)
--   3. npx prisma generate   (tra lai client theo schema cu)
--
-- Postgres KHONG ho tro ALTER TYPE ... DROP VALUE, nen phai tao lai type va swap.
-- Truoc khi swap, moi row co status moi phai duoc convert ve gia tri legacy:
--   MINTING -> PENDING   (mint chua xac dinh ket qua — an toan nhat cho lazy-claim lai)
--   MINTED  -> CLAIMED   (contentTicketId da set — dung semantics CLAIMED legacy:
--                          giong hang CLAIMED cu co contentTicketId + claimedAt;
--                          dat claimedAt = mintedAt de khong roi trang thai lai)
--   LINKED  -> CLAIMED   (da link user — CLAIMED la terminal gan nhat)
-- Neu muon xem truoc so row se bi convert:
--   SELECT status, count(*) FROM "PreTicket" GROUP BY status;
--
-- Δ6 note: cot recipientUserId BI DROP hoan toan (nullable, khong phuc hoi NOT NULL)
-- nen KHONG can placeholder. Neu quy trinh moi sau nay yeu cau phuc hoi cot NOT NULL
-- (vd userId cua content-service), dung placeholder per-row
-- 'ROLLBACK-UNLINKED-<uuid>' — KHONG dung chuoi co dinh vi pham unique.

BEGIN;

-- B0. Phan loai + convert status moi ve legacy TRUOC khi doi type
UPDATE "PreTicket"
SET "claimedAt" = COALESCE("claimedAt", "mintedAt", now())
WHERE "status" IN ('MINTED', 'LINKED');

UPDATE "PreTicket"
SET "status" = 'CLAIMED'
WHERE "status" IN ('MINTED', 'LINKED');

UPDATE "PreTicket"
SET "status" = 'PENDING'
WHERE "status" = 'MINTING';

-- B1. Drop index moi
DROP INDEX IF EXISTS "PreTicket_recipientEmailHash_status_idx";
DROP INDEX IF EXISTS "PreTicket_ticketTypeId_status_createdAt_idx";

-- B2. Swap PreTicketStatus ve type chi con gia tri legacy
--     (DROP DEFAULT truoc — column default phu thuoc vao type, khong drop duoc type)
ALTER TABLE "PreTicket" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PreTicket" ALTER COLUMN "status" TYPE TEXT;
DROP TYPE IF EXISTS "PreTicketStatus";
CREATE TYPE "PreTicketStatus" AS ENUM ('PENDING', 'CLAIMING', 'CLAIMED', 'EXPIRED');
ALTER TABLE "PreTicket" ALTER COLUMN "status" TYPE "PreTicketStatus"
  USING ("status"::"PreTicketStatus");
ALTER TABLE "PreTicket" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"PreTicketStatus";

-- B3. Swap DistributionStatus ve type cu (bo PARTIALLY_MINTED)
--     Job PARTIALLY_MINTED -> FAILED (mot phan mint thatai — FAILED la trang thai
--     gan nhat cua he thong cu de admin review lai).
UPDATE "DistributionJob" SET "status" = 'FAILED' WHERE "status" = 'PARTIALLY_MINTED';
ALTER TABLE "DistributionJob" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "DistributionJob" ALTER COLUMN "status" TYPE TEXT;
DROP TYPE IF EXISTS "DistributionStatus";
CREATE TYPE "DistributionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
ALTER TABLE "DistributionJob" ALTER COLUMN "status" TYPE "DistributionStatus"
  USING ("status"::"DistributionStatus");
ALTER TABLE "DistributionJob" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"DistributionStatus";

-- B4. Drop cot moi
ALTER TABLE "PreTicket" DROP COLUMN IF EXISTS "recipientUserId";
ALTER TABLE "PreTicket" DROP COLUMN IF EXISTS "mintedAt";
ALTER TABLE "PreTicket" DROP COLUMN IF EXISTS "lastMintError";
ALTER TABLE "PreTicket" DROP COLUMN IF EXISTS "emailSentAt";
ALTER TABLE "DistributionJob" DROP COLUMN IF EXISTS "mintMode";

COMMIT;
