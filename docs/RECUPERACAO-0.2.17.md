# NetInventory 0.2.17 — recuperação da versão completa

Data: 11/10/2026.

## Objetivo e causa

Recuperar as funcionalidades existentes na versão 0.2.16 e incorporar as correções posteriores de SNMP e do scan manual.

A instalação observada em `C:\Program Files\NetInventory\app\package.json` indicava 0.2.11. O ramo de correções SNMP (`a5dadae`) partiu de `0e143fb`, anterior ao conjunto completo de alertas (`8d40b7a`) e à identificação 0.2.16 (`3d0f4b6`). Portanto, a instalação desse ramo deixou de fora essas adições. Elas permaneciam preservadas no histórico Git.

O log do serviço também confirmou o motivo do erro da imagem: o scan manual tentou iniciar durante um scan já em andamento. A exceção chegava ao cliente como erro genérico de produção.

## Conteúdo consolidado

- Os 29 arquivos de recursos e documentação do commit `8d40b7a`, excluindo apenas metadados de versão/dependências, foram comparados com o histórico e recuperados integralmente: página Alertas, navegação, modos completo/crítico, latência crítica, checagem a cada 15 segundos, repetição configurável, e-mails com métricas agrupadas, melhorias dos seletores, guias e modelos de contribuição.
- Mantidas as correções presentes em `a5dadae`: autenticação e privacidade SNMPv3, Printer-MIB e apresentação dos suprimentos da impressora.
- Scan manual devolve resultados e erros esperados como dados; concorrência gera aviso informativo. A interface consulta o estado atual e desabilita o botão enquanto há scan em andamento.
- Falhas inesperadas do scan não expõem detalhes internos ao cliente. Permissões permanecem verificadas no servidor.
- Instalador deixa de encerrar indiscriminadamente todos os processos Node e interrompe a atualização se não conseguir parar/remover o serviço NetInventory.
- Número novo 0.2.17 para preservar os instaladores 0.2.15 e 0.2.16 existentes.

## Arquivos principais

Código consolidado em `D:\Net-Inventory\wt-snmpv3-auth`, com alterações locais ainda sem commit/push. A cópia antiga `D:\Net-Inventory\net-inventory-ia` e suas modificações anteriores foram preservadas; apenas novos artefatos foram acrescentados em `installer\output`.

Arquivos do reparo do scan: `src/app/actions/scan-actions.ts`, `src/app/actions/scan-actions.test.ts`, `src/app/api/scan-status/route.ts`, `src/hooks/use-devices.ts`, `src/components/scan-button.tsx`.

Arquivos de empacotamento: `installer/netinventory.iss`, `installer/build.mjs`, `installer/runtime/launcher.cjs`, `package.json`, `package-lock.json`. Os arquivos de alertas, navegação, seletores e documentação foram restaurados do conjunto histórico acima.

## Validações

- 161 testes em 27 arquivos passaram, incluindo concorrência de scan, permissão, sessão expirada, erro interno sanitizado e testes recuperados de alertas/SNMP.
- ESLint, TypeScript e `git diff --check` passaram.
- Build de produção e compilação Inno Setup concluídos.
- Pacote usa Node 24.19.0; não contém arquivos `.env` ou bancos `.db`.
- Aplicação empacotada executada em `127.0.0.1:3010`, com banco vazio exclusivo de teste e usuário fictício: login, scan de `127.0.0.1/32`, botão desabilitado durante execução, retorno ao inventário e página Alertas com modo crítico/latência crítica verificados no navegador.
- Nenhum e-mail foi enviado durante a validação. Configurações e banco reais não foram alterados.

## Artefatos

Instalador: `D:\Net-Inventory\net-inventory-ia\installer\output\NetInventory-Setup-0.2.17.exe`.

Tamanho: 49.884.276 bytes.

SHA-256: `826de975bfe0a8f10df2aa99b78206031e5fd65cbb2c8952a61e70392197cd31`.

Evidência visual: `NetInventory-0.2.17-alertas.png` na mesma pasta, capturada no ambiente isolado de teste.

## Pendências e limites

A versão instalada continua identificada como 0.2.11. Esta sessão não está elevada como administrador. Execute o instalador 0.2.17 para aplicar a atualização; depois recarregue a página do navegador para evitar referências de ações de uma versão anterior.

A atualização do serviço pelo instalador, a comunicação com equipamentos reais e o envio real via Resend ainda não foram validados nesta execução. O teste de navegador usou somente dados separados e o host local. Não houve publicação no GitHub nem atualização do site público.
