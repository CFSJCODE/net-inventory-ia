-- AlterTable
ALTER TABLE "StatusService" ADD COLUMN "latencyMs" REAL;
ALTER TABLE "StatusService" ADD COLUMN "measuredReason" TEXT;
ALTER TABLE "StatusService" ADD COLUMN "measuredStatus" TEXT;
ALTER TABLE "StatusService" ADD COLUMN "officialState" TEXT;

-- Até aqui o status gravado era só o oficial: vira o estado oficial dos serviços com fonte.
UPDATE "StatusService" SET "officialState" = "status" WHERE "sourceType" <> 'NONE';

-- CreateTable
CREATE TABLE "ProbeTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "url" TEXT,
    "port" INTEGER,
    "intervalSec" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "statusReason" TEXT,
    "lastCheckAt" DATETIME,
    "lastLatencyMs" REAL,
    "lastError" TEXT,
    CONSTRAINT "ProbeTarget_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "StatusService" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProbeCheck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "targetId" TEXT NOT NULL,
    "vantage" TEXT NOT NULL DEFAULT 'server',
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" REAL,
    "httpStatus" INTEGER,
    "dnsMs" REAL,
    "connectMs" REAL,
    "tlsMs" REAL,
    "ttfbMs" REAL,
    "totalMs" REAL,
    "lossPct" REAL,
    "jitterMs" REAL,
    "certDays" INTEGER,
    "error" TEXT,
    CONSTRAINT "ProbeCheck_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "ProbeTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProbeRollup" (
    "targetId" TEXT NOT NULL,
    "vantage" TEXT NOT NULL,
    "bucket" DATETIME NOT NULL,
    "samples" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "p50Ms" REAL,
    "p95Ms" REAL,
    "maxMs" REAL,
    "lossPct" REAL,

    PRIMARY KEY ("targetId", "vantage", "bucket"),
    CONSTRAINT "ProbeRollup_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "ProbeTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProbeTarget_serviceId_key_key" ON "ProbeTarget"("serviceId", "key");

-- CreateIndex
CREATE INDEX "ProbeCheck_targetId_at_idx" ON "ProbeCheck"("targetId", "at");

-- CreateIndex
CREATE INDEX "ProbeCheck_at_idx" ON "ProbeCheck"("at");

-- CreateIndex
CREATE INDEX "ProbeRollup_bucket_idx" ON "ProbeRollup"("bucket");

