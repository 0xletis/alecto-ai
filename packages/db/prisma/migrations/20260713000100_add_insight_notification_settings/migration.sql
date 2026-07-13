ALTER TABLE "NotificationSettings"
ADD COLUMN "dailyInsightEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "dailyInsightTime" TEXT,
ADD COLUMN "weeklyInsightEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "weeklyInsightDay" TEXT,
ADD COLUMN "weeklyInsightTime" TEXT;
