ALTER TABLE "NotificationSettings"
ADD COLUMN "dailyLoopEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "DailyLoopState" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "localDate" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
  "morningBriefSentAt" TIMESTAMP(3),
  "middayNudgeSentAt" TIMESTAMP(3),
  "eveningReviewSentAt" TIMESTAMP(3),
  "eveningReviewCompletedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'not_started',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DailyLoopState_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DailyLoopState_userId_idx" ON "DailyLoopState"("userId");
CREATE UNIQUE INDEX "DailyLoopState_userId_localDate_key" ON "DailyLoopState"("userId", "localDate");

ALTER TABLE "DailyLoopState"
ADD CONSTRAINT "DailyLoopState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
