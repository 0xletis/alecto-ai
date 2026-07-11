-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "archiveReason" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "correctedByEventId" TEXT,
ADD COLUMN     "eventGroupId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateIndex
CREATE INDEX "Event_userId_status_idx" ON "Event"("userId", "status");

-- CreateIndex
CREATE INDEX "Event_userId_eventGroupId_idx" ON "Event"("userId", "eventGroupId");
