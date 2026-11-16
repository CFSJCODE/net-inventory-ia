-- Fase 10: resumo diário das rotas (as rotas cruas ficam 7 dias).
CREATE TABLE "RouteDaily" (
    "serviceId" TEXT NOT NULL,
    "vantage" TEXT NOT NULL DEFAULT 'server',
    "day" TEXT NOT NULL,
    "traces" INTEGER NOT NULL,
    "international" INTEGER NOT NULL,
    "domestic" INTEGER NOT NULL,
    "pathChanges" INTEGER NOT NULL,
    "topVerdict" TEXT,
    "topAsPath" TEXT,
    "topExit" TEXT,
    "avgDestRttMs" REAL,

    PRIMARY KEY ("serviceId", "vantage", "day"),
    CONSTRAINT "RouteDaily_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "StatusService" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RouteDaily_day_idx" ON "RouteDaily"("day");
