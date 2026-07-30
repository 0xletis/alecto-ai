ALTER TABLE "Goal"
ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'medium',
ADD COLUMN "importanceScore" DOUBLE PRECISION,
ADD COLUMN "priorityReason" TEXT;
