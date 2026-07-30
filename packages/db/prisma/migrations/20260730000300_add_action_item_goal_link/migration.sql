ALTER TABLE "ActionItem"
ADD COLUMN "goalId" TEXT,
ADD COLUMN "goalSlug" TEXT,
ADD COLUMN "goalTitleSnapshot" TEXT;

CREATE INDEX "ActionItem_userId_goalId_idx" ON "ActionItem"("userId", "goalId");
