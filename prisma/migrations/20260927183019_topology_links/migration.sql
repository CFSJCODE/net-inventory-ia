-- CreateTable
CREATE TABLE "TopologyLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromDeviceId" TEXT NOT NULL,
    "toDeviceId" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "failures" INTEGER NOT NULL DEFAULT 0,
    "downReason" TEXT,
    "latencyMs" INTEGER,
    "lastCheckAt" DATETIME,
    "lastChangeAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TopologyLink_fromDeviceId_fkey" FOREIGN KEY ("fromDeviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TopologyLink_toDeviceId_fkey" FOREIGN KEY ("toDeviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TopologyLink_fromDeviceId_toDeviceId_key" ON "TopologyLink"("fromDeviceId", "toDeviceId");
