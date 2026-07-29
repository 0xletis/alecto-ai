CREATE TABLE "ActionItemReminderLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionItemId" TEXT NOT NULL,
    "reminderType" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionItemReminderLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActionItemReminderLog_userId_idx" ON "ActionItemReminderLog"("userId");
CREATE INDEX "ActionItemReminderLog_actionItemId_reminderType_sentAt_idx" ON "ActionItemReminderLog"("actionItemId", "reminderType", "sentAt");

ALTER TABLE "ActionItemReminderLog"
ADD CONSTRAINT "ActionItemReminderLog_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActionItemReminderLog"
ADD CONSTRAINT "ActionItemReminderLog_actionItemId_fkey"
FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
