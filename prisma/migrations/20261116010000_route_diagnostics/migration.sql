-- Fase 7: modo do traceroute, último roteador visível, ECMP e papel do roteador.
ALTER TABLE "RouteTrace" ADD COLUMN "mode" TEXT;
ALTER TABLE "RouteTrace" ADD COLUMN "lastVisibleTtl" INTEGER;
ALTER TABLE "RouteHop" ADD COLUMN "altIps" TEXT;
ALTER TABLE "RouteHop" ADD COLUMN "role" TEXT;
