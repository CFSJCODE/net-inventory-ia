CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "costUsd" REAL,
    "durationMs" INTEGER NOT NULL,
    "httpStatus" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");
CREATE INDEX "AiUsage_provider_createdAt_idx" ON "AiUsage"("provider", "createdAt");
