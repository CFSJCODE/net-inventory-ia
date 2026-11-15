-- CreateTable
CREATE TABLE "RouteTrace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "vantage" TEXT NOT NULL DEFAULT 'server',
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "host" TEXT NOT NULL,
    "destIp" TEXT,
    "tool" TEXT,
    "reached" BOOLEAN NOT NULL DEFAULT false,
    "destRttMs" REAL,
    "verdict" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "destCountry" TEXT,
    "cableId" TEXT,
    "cableName" TEXT,
    "candidates" TEXT,
    "confidence" TEXT,
    "asPath" TEXT,
    "error" TEXT,
    CONSTRAINT "RouteTrace_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "StatusService" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RouteHop" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "traceId" TEXT NOT NULL,
    "ttl" INTEGER NOT NULL,
    "ip" TEXT,
    "rttMs" REAL,
    "asn" INTEGER,
    "asName" TEXT,
    "rdns" TEXT,
    "city" TEXT,
    "country" TEXT,
    CONSTRAINT "RouteHop_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "RouteTrace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RouteTrace_serviceId_at_idx" ON "RouteTrace"("serviceId", "at");

-- CreateIndex
CREATE INDEX "RouteTrace_at_idx" ON "RouteTrace"("at");

-- CreateIndex
CREATE INDEX "RouteHop_traceId_idx" ON "RouteHop"("traceId");
