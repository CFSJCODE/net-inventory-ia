@echo off
setlocal
set "NETINVENTORY_UNIFY_READY=%~dp0..\.artifacts\unified-validation.ready"
if not exist "%NETINVENTORY_UNIFY_READY%" (
  echo A validacao unificada ainda nao foi concluida. Nenhum servico foi alterado.
  exit /b 2
)
echo Unificando o NetInventory em localhost:3000. O Windows solicitara acesso de administrador.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Unify-Local3000-Elevated.ps1" -Launch
set "NETINVENTORY_UNIFY_CODE=%ERRORLEVEL%"
if "%NETINVENTORY_UNIFY_CODE%"=="0" (
  echo NetInventory unificado. Abra http://localhost:3000/ para entrar.
) else (
  echo Unificacao nao confirmada. Consulte o estado privado em .data\migration\unification-status.local.json.
)
exit /b %NETINVENTORY_UNIFY_CODE%
