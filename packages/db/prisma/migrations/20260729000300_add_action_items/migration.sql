CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceProvider" TEXT,
    "sourceRuleId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "dueAt" TIMESTAMP(3),
    "project" TEXT,
    "actionType" TEXT,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EmailReviewItem"
ADD COLUMN "actionItemId" TEXT;

CREATE INDEX "ActionItem_userId_status_idx" ON "ActionItem"("userId", "status");
CREATE INDEX "ActionItem_userId_dueAt_idx" ON "ActionItem"("userId", "dueAt");
CREATE INDEX "ActionItem_source_sourceId_idx" ON "ActionItem"("source", "sourceId");

ALTER TABLE "ActionItem"
ADD CONSTRAINT "ActionItem_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
