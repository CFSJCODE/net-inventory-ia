# Script de atualização da ferramenta local NetInventory (executar como Administrador)
$ErrorActionPreference = "Stop"

Write-Host "=== Atualizando NetInventory Local ===" -ForegroundColor Cyan

$targetApp = "C:\Program Files\NetInventory\app"
$sourceApp = "D:\Net-Inventory\net-inventory-ia\.next-installer\standalone"

if (!(Test-Path $sourceApp)) {
    Write-Error "Pasta de build standalone não encontrada em $sourceApp. Execute o build primeiro."
    exit 1
}

Write-Host "1. Interrompendo serviço NetInventory..." -ForegroundColor Yellow
Stop-Service NetInventory -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "2. Atualizando arquivos em $targetApp..." -ForegroundColor Yellow
Copy-Item -Path "$sourceApp\*" -Destination $targetApp -Recurse -Force

Write-Host "3. Iniciando serviço NetInventory..." -ForegroundColor Yellow
Start-Service NetInventory

Start-Sleep -Seconds 2
$svc = Get-Service NetInventory
Write-Host "4. Status do serviço: $($svc.Status)" -ForegroundColor Green
Write-Host "=== NetInventory atualizado com sucesso em http://localhost:3000 ===" -ForegroundColor Green
