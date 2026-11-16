-- Switch Health: contadores IF-MIB por porta e o total por rodada, com a latência do mesmo instante.
CREATE TABLE "SwitchHealthSample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "equipmentId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intervalSec" INTEGER NOT NULL,
    "errorsPerMin" REAL,
    "crcPerMin" REAL,
    "discardsPerMin" REAL,
    "inBps" REAL,
    "outBps" REAL,
    "worstPort" TEXT,
    "latencyMs" REAL,
    "lossPct" REAL,
    "gatewayLatencyMs" REAL,
    CONSTRAINT "SwitchHealthSample_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SwitchPortSample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "equipmentId" TEXT NOT NULL,
    "ifIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operUp" BOOLEAN NOT NULL,
    "speedMbps" INTEGER,
    "inErrors" INTEGER,
    "outErrors" INTEGER,
    "inDiscards" INTEGER,
    "outDiscards" INTEGER,
    "crcErrors" INTEGER,
    "errorsPerMin" REAL,
    "discardsPerMin" REAL,
    "crcPerMin" REAL,
    "inBps" REAL,
    "outBps" REAL,
    "utilPct" REAL,
    CONSTRAINT "SwitchPortSample_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SwitchHealthSample_equipmentId_at_idx" ON "SwitchHealthSample"("equipmentId", "at");
CREATE INDEX "SwitchHealthSample_at_idx" ON "SwitchHealthSample"("at");
CREATE INDEX "SwitchPortSample_equipmentId_ifIndex_at_idx" ON "SwitchPortSample"("equipmentId", "ifIndex", "at");
CREATE INDEX "SwitchPortSample_at_idx" ON "SwitchPortSample"("at");
