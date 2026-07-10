-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "checkInConfig" JSONB,
ADD COLUMN     "targetMetrics" JSONB,
ADD COLUMN     "templateId" TEXT;
