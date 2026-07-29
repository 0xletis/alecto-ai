CREATE TABLE "EmailReviewItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "adapterId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "subject" TEXT,
    "from" TEXT,
    "snippet" TEXT,
    "evidence" TEXT,
    "proposedEventType" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "extracted" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "eventId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailReviewItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailReviewItem_externalId_key" ON "EmailReviewItem"("externalId");
CREATE INDEX "EmailReviewItem_userId_status_idx" ON "EmailReviewItem"("userId", "status");
CREATE INDEX "EmailReviewItem_ruleId_status_idx" ON "EmailReviewItem"("ruleId", "status");

ALTER TABLE "EmailReviewItem"
ADD CONSTRAINT "EmailReviewItem_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailReviewItem"
ADD CONSTRAINT "EmailReviewItem_connectionId_fkey"
FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailReviewItem"
ADD CONSTRAINT "EmailReviewItem_ruleId_fkey"
FOREIGN KEY ("ruleId") REFERENCES "EmailSignalRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
