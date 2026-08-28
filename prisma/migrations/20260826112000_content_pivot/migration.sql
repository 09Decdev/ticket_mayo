-- DropForeignKey
ALTER TABLE "PreTicket" DROP CONSTRAINT "PreTicket_ticketId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_eventId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_ticketTypeId_fkey";

-- DropForeignKey
ALTER TABLE "TicketType" DROP CONSTRAINT "TicketType_eventId_fkey";

-- DropIndex
DROP INDEX "PreTicket_ticketId_key";

-- AlterTable
ALTER TABLE "PreTicket" DROP COLUMN "ticketId",
ADD COLUMN     "contentTicketId" TEXT;

-- AlterTable
ALTER TABLE "PreTicket" ADD COLUMN "contentTicketCode" TEXT;

-- DropTable
DROP TABLE "Event";

-- DropTable
DROP TABLE "Ticket";

-- DropTable
DROP TABLE "TicketType";

-- DropEnum
DROP TYPE "TicketStatus";

-- CreateIndex
CREATE UNIQUE INDEX "PreTicket_contentTicketId_key" ON "PreTicket"("contentTicketId");