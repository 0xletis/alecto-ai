-- AlterTable
ALTER TABLE "NotificationSettings" ADD COLUMN     "eveningCheckinEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gmailNudgeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "morningBriefEnabled" BOOLEAN NOT NULL DEFAULT false;
