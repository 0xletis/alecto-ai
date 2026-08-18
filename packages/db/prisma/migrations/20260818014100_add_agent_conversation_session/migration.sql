-- CreateTable
CREATE TABLE "AgentConversationSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "topic" TEXT,
    "focusedEntities" JSONB,
    "pendingOperation" JSONB,
    "visibleEntities" JSONB,
    "recentMutations" JSONB,
    "messages" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConversationSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentConversationSession_userId_idx" ON "AgentConversationSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConversationSession_userId_channel_key" ON "AgentConversationSession"("userId", "channel");

-- AddForeignKey
ALTER TABLE "AgentConversationSession" ADD CONSTRAINT "AgentConversationSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
