-- AlterEnum
ALTER TYPE "DistributionStatus" ADD VALUE 'PARTIALLY_MINTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PreTicketStatus" ADD VALUE 'MINTING';
ALTER TYPE "PreTicketStatus" ADD VALUE 'MINTED';
ALTER TYPE "PreTicketStatus" ADD VALUE 'LINKED';

-- AlterTable
ALTER TABLE "DistributionJob" ADD COLUMN     "mintMode" TEXT NOT NULL DEFAULT 'LAZY';

-- AlterTable
ALTER TABLE "PreTicket" ADD COLUMN     "emailSentAt" TIMESTAMP(3),
ADD COLUMN     "lastMintError" TEXT,
ADD COLUMN     "mintedAt" TIMESTAMP(3),
ADD COLUMN     "recipientUserId" TEXT;

-- CreateIndex
CREATE INDEX "PreTicket_recipientEmailHash_status_idx" ON "PreTicket"("recipientEmailHash", "status");

-- CreateIndex
CREATE INDEX "PreTicket_ticketTypeId_status_createdAt_idx" ON "PreTicket"("ticketTypeId", "status", "createdAt");
