-- ADD COLUMN em vez de redefinir a tabela: preserva qualquer coluna adicionada por outra migração ao Device.
ALTER TABLE "Device" ADD COLUMN "uplinkId" TEXT CONSTRAINT "Device_uplinkId_fkey" REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
