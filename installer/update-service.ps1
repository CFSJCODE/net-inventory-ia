# Script de atualização direta do serviço NetInventory
$ErrorActionPreference = "Continue"

Write-Host "1. Parando servico NetInventory..." -ForegroundColor Cyan
& net.exe stop NetInventory
& sc.exe stop NetInventory
Start-Sleep -Seconds 2

Write-Host "2. Finalizando processos residuais..." -ForegroundColor Cyan
& taskkill.exe /F /T /IM NetInventory.exe
& taskkill.exe /F /T /IM node.exe
Start-Sleep -Seconds 2

Write-Host "3. Copiando arquivos novos para C:\Program Files\NetInventory..." -ForegroundColor Cyan
$source = "D:\Net-Inventory\net-inventory-ia\installer\dist\NetInventory\*"
$dest = "C:\Program Files\NetInventory\"

Copy-Item -Path $source -Destination $dest -Recurse -Force
Start-Sleep -Seconds 1

Write-Host "4. Iniciando servico NetInventory atualizado..." -ForegroundColor Cyan
& net.exe start NetInventory

Write-Host "Atualizacao concluida com sucesso!" -ForegroundColor Green
Start-Sleep -Seconds 3
