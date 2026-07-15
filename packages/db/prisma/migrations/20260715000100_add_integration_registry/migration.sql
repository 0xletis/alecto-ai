ALTER TABLE "Event"
ADD COLUMN "externalId" TEXT,
ADD COLUMN "provider" TEXT;

CREATE UNIQUE INDEX "Event_userId_source_externalId_key" ON "Event"("userId", "source", "externalId");

CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "config" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationSyncLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "eventsCreated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "IntegrationSyncLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrationConnection_userId_idx" ON "IntegrationConnection"("userId");
CREATE INDEX "IntegrationConnection_userId_integrationId_idx" ON "IntegrationConnection"("userId", "integrationId");
CREATE INDEX "IntegrationSyncLog_userId_idx" ON "IntegrationSyncLog"("userId");
CREATE INDEX "IntegrationSyncLog_connectionId_idx" ON "IntegrationSyncLog"("connectionId");

ALTER TABLE "IntegrationConnection"
ADD CONSTRAINT "IntegrationConnection_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationSyncLog"
ADD CONSTRAINT "IntegrationSyncLog_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationSyncLog"
ADD CONSTRAINT "IntegrationSyncLog_connectionId_fkey"
FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
