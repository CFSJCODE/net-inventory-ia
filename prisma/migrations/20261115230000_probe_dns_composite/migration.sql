-- Fase 6: DNS composto (código de resposta, TTL e respostas por resolvedor) nas medições.
ALTER TABLE "ProbeCheck" ADD COLUMN "rcode" TEXT;
ALTER TABLE "ProbeCheck" ADD COLUMN "ttlSec" INTEGER;
ALTER TABLE "ProbeCheck" ADD COLUMN "dnsAnswers" TEXT;
