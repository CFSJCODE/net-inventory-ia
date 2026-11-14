-- CreateTable
CREATE TABLE "StatusService" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'NONE',
    "sourceUrl" TEXT,
    "pageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "officialStatus" TEXT,
    "lastError" TEXT,
    "lastCheckAt" DATETIME,
    "lastChangeAt" DATETIME,
    "sourceVersion" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "StatusComponent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groupName" TEXT,
    "status" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StatusComponent_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "StatusService" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StatusIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "url" TEXT,
    "affected" TEXT,
    "startedAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StatusIncident_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "StatusService" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StatusService_slug_key" ON "StatusService"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "StatusComponent_serviceId_externalId_key" ON "StatusComponent"("serviceId", "externalId");

-- CreateIndex
CREATE INDEX "StatusIncident_resolvedAt_idx" ON "StatusIncident"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StatusIncident_serviceId_origin_externalId_key" ON "StatusIncident"("serviceId", "origin", "externalId");
