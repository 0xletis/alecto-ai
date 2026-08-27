-- AlterTable
ALTER TABLE "EmailReviewItem" ADD COLUMN     "domain" TEXT,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'normal';

-- AlterTable
ALTER TABLE "EmailSignalRule" ADD COLUMN     "description" TEXT,
ADD COLUMN     "domain" TEXT,
ADD COLUMN     "notifyPolicy" TEXT NOT NULL DEFAULT 'review_only';
