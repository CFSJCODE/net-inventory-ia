-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ip" TEXT NOT NULL,
    "mac" TEXT,
    "ipv6" TEXT,
    "hostname" TEXT,
    "alias" TEXT,
    "typeLocked" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "vendor" TEXT,
    "type" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "os" TEXT,
    "loggedUser" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "openPorts" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Device" ("createdAt", "firstSeenAt", "hostname", "id", "ip", "ipv6", "lastSeenAt", "loggedUser", "mac", "openPorts", "os", "status", "type", "updatedAt", "vendor") SELECT "createdAt", "firstSeenAt", "hostname", "id", "ip", "ipv6", "lastSeenAt", "loggedUser", "mac", "openPorts", "os", "status", "type", "updatedAt", "vendor" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
CREATE UNIQUE INDEX "Device_mac_key" ON "Device"("mac");
CREATE INDEX "Device_ip_idx" ON "Device"("ip");
CREATE INDEX "Device_status_idx" ON "Device"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
