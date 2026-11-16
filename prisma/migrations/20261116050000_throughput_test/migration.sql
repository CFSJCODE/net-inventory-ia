-- Testes de banda da rede local (iperf3) enviados pelos agentes.
CREATE TABLE "ThroughputTest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vantage" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "server" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "durationSec" REAL,
    "uploadMbps" REAL,
    "downloadMbps" REAL,
    "retransmits" INTEGER,
    "error" TEXT
);

CREATE UNIQUE INDEX "ThroughputTest_vantage_at_key" ON "ThroughputTest"("vantage", "at");
CREATE INDEX "ThroughputTest_at_idx" ON "ThroughputTest"("at");
