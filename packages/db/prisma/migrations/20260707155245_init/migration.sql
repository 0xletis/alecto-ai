-- CreateTable
CREATE TABLE "UserOperatingProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "directness" INTEGER NOT NULL DEFAULT 3,
    "warmth" INTEGER NOT NULL DEFAULT 3,
    "humor" INTEGER NOT NULL DEFAULT 2,
    "confrontation" INTEGER NOT NULL DEFAULT 3,
    "verbosity" INTEGER NOT NULL DEFAULT 3,
    "profanityAllowed" BOOLEAN NOT NULL DEFAULT false,
    "motivationalStyle" TEXT NOT NULL DEFAULT 'strategic',
    "accountabilityStrictness" INTEGER NOT NULL DEFAULT 3,
    "reminderFrequency" TEXT NOT NULL DEFAULT 'medium',
    "escalationStyle" TEXT NOT NULL DEFAULT 'firm',
    "requiresEvidence" BOOLEAN NOT NULL DEFAULT true,
    "gamblingGuardrails" TEXT NOT NULL DEFAULT 'strict',
    "selfDeceptionSensitivity" INTEGER NOT NULL DEFAULT 4,
    "cooldownPreference" TEXT NOT NULL DEFAULT 'require_confirmation',
    "vulnerableMode" TEXT NOT NULL DEFAULT 'soften',
    "avoidingMode" TEXT NOT NULL DEFAULT 'challenge',
    "impulsiveMode" TEXT NOT NULL DEFAULT 'guardian_mode',
    "effectivePhrases" JSONB,
    "ineffectivePhrases" JSONB,
    "knownTriggers" JSONB,
    "knownFailureModes" JSONB,
    "knownStrengths" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserOperatingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserOperatingProfile_userId_key" ON "UserOperatingProfile"("userId");

-- AddForeignKey
ALTER TABLE "UserOperatingProfile" ADD CONSTRAINT "UserOperatingProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
