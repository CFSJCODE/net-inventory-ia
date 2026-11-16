-- Fase 8: borda do CDN que atendeu a sonda HTTP (cabeçalhos cf-ray, x-amz-cf-pop, x-served-by…).
ALTER TABLE "ProbeCheck" ADD COLUMN "edge" TEXT;
