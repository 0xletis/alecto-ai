CREATE TABLE "EmailSignalRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "goalId" TEXT,
    "adapterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reviewBeforeLogging" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSignalRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailSignalRule_userId_idx" ON "EmailSignalRule"("userId");
CREATE INDEX "EmailSignalRule_connectionId_idx" ON "EmailSignalRule"("connectionId");
CREATE INDEX "EmailSignalRule_userId_status_idx" ON "EmailSignalRule"("userId", "status");

ALTER TABLE "EmailSignalRule"
ADD CONSTRAINT "EmailSignalRule_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailSignalRule"
ADD CONSTRAINT "EmailSignalRule_connectionId_fkey"
FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
