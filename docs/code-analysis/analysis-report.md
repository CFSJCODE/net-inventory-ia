# Análise conservadora — descoberta e varredura estática

Data: 2026-10-13. Raiz: `D:\Net-Inventory\net-inventory-ia`.

## Resultado e alcance

Nenhum código foi modificado ou removido. A descoberta e a varredura automática das fontes estão concluídas; revisão manual aprofundada de cada módulo, scripts e fluxos de execução continua pendente. Este documento não certifica ausência de código morto nem paridade com a instalação.

Foram analisados 214 arquivos TypeScript, dos quais 27 testes, com 594 referências de import/export entre módulos. ESLint cobriu os 214 arquivos: zero erros e zero avisos. TypeScript, com noUnusedLocals/noUnusedParameters e exclusão em memória dos artefatos .next*, terminou com zero diagnósticos. O arquivo de configuração original não foi alterado. A checagem usando o tsconfig original falhou com três TS2307 referentes a uma página ausente em tipos gerados do instalador.

Referências dos candidatos foram pesquisadas nas fontes, scripts do instalador, documentação, site e CI. A configuração ESLint exclui installer; lint aprovado em src não valida os scripts de empacotamento. Nenhum script de atualização, build, migração, serviço ou teste de rede foi executado. A suíte Vitest e E2E não foram executadas: esta etapa só documentou achados.

## Achados priorizados

| ID | Local | Evidência | Classificação/impacto | Recomendação |
|---|---|---|---|---|
| A01 | src/components/ui/airplane.tsx:24 | Arquivo sem importadores no grafo de src; nome/caminho sem consumidor encontrado nos locais pesquisados | Candidato a arquivo órfão; baixo impacto aparente; não prova ausência de uso em fontes não recuperadas | Considerar remoção integral após aprovação e confirmação de intenção de manter catálogo de ícones |
| A02 | src/components/ui/wifi.tsx:25 | Mesma verificação de A01 | Candidato a arquivo órfão; baixo impacto aparente | Mesmo procedimento de A01 |
| A03 | src/hooks/use-devices.ts:21 | useDevice aparece somente na declaração na busca realizada | Hook exportado sem consumidor identificado; módulo tem outros hooks usados | Revisar possível consumidor da página de dispositivo; eventual remoção somente da função useDevice, preservando useDevices e demais hooks |
| A04 | src/lib/ai/client.ts:42 | isAiConfigured aparece somente na declaração na busca realizada | Helper exportado sem consumidor identificado; arquivo possui alterações locais | Confirmar substituição por getAiStatus/getAiConfig antes de propor remoção da função |
| A05 | src/lib/ai/settings.ts:63 | clearAiConfigCache aparece somente na declaração na busca realizada | Helper de invalidação sem consumidor identificado; risco de manutenção/integração | Verificar fluxo de gravação e invalidação de configuração antes de decidir |
| A06 | src/app/actions/ai-actions.ts:144 | getDeviceFindings aparece somente na declaração na busca realizada | Server Action sem consumidor identificado; interface pública e alterações locais | Conferir cliente, manifestos e baseline completo; não remover com base apenas no grafo |
| D01 | .next-installer/types/app/equipment/page.ts:2 e :5; .next-installer/types/validator.ts:80 | Três TS2307 apontam para src/app/equipment/page ausente | Inconsistência entre artefatos gerados e checkout; pode refletir fontes incompletas | Não apagar tipos ou criar página substituta; decidir recuperação da base completa/regeneração isolada em etapa própria |
| D02 | src/lib/ai/settings.ts:31-38 | Quando AUTH_SECRET está ausente, a expressão alternativa seleciona um fallback constante em qualquer NODE_ENV; o ramo que lança por ausência não é atingido nesse caso | Problema potencial de configuração/criptografia, prioritário em relação à economia de fontes; observado no código, sem comprovação de condição na instalação | Revisar política de fallback e compatibilidade de dados antes de propor correção; não alterar segredo, configuração ou criptografia nesta análise |

Em D02, a rejeição de segredo curto continua alcançável. O problema é especificamente a ausência, não todo o bloco de validação. `src/lib/auth/session.ts:34-36` valida a ausência separadamente, mas isso não modifica o comportamento do helper de criptografia. Nenhum segredo real ou estado da instalação foi consultado.

A05 teve a revisão básica de fluxo concluída: `saveAiConfig` e `removeAiKey` invalidam `cache` diretamente em `settings.ts:176` e `:199`. Isso explica por que o helper separado não tem consumidor; ainda é necessário avaliar a API entre versões antes de removê-lo.

## Falsos positivos descartados

- `src/components/equipment/nest-monitoring-panel.tsx:55` é consumido por leitura textual e transpile em `installer/nest-monitoring-panel-lib.mjs:28`, e está incluído em `installer/nest-panel-tsconfig.json`. Preservar.
- `src/instrumentation.ts`, `src/middleware.ts`, páginas/layouts/loading e handlers GET são pontos de entrada convencionais, mesmo sem importação explícita. Preservar.
- `startLinkMonitor` e `startScanScheduler` são chamados em `src/instrumentation.ts:5-9` via import dinâmico com destructuring. O rastreador experimental de símbolos não capturou corretamente essa relação; suas saídas não autorizam remoção.
- `AiNotConfigured`, `aiModel`, `aiProvider`, `getAiClient` e `OUI_VENDORS` possuem consumidores dentro de seus módulos. Não confundir export sem consumidor externo com implementação morta.
- Tipos exportados e partes opcionais dos componentes UI não foram classificados automaticamente como removíveis. Inferência de tipos e API de componentes exigem revisão específica.
- `cn` e `shadcn` têm usos explícitos; `shadcn/tailwind.css` é importado em globals.css. `sharp` é usado no instalador. Pacotes que não aparecem em imports diretos ainda podem ser exigidos pelo framework ou por outro pacote; não há proposta de remoção de dependências nesta etapa.

## Proposta concreta para revisão, ainda não aprovada

O primeiro lote possível contém apenas a exclusão integral de:

1. `src/components/ui/airplane.tsx` — 3.880 bytes.
2. `src/components/ui/wifi.tsx` — 3.093 bytes.

Total: 6.973 bytes de fontes, aproximadamente 6,8 KiB. Essa medida não estima economia de bundle, desempenho ou instalador; arquivos já ausentes do grafo ativo podem não participar do build. Não incluir remoção de pacotes motion/react, funções auxiliares ou outros ícones neste lote. Confiança: ausência de consumidor no checkout pesquisado confirmada; segurança entre versões ainda condicionada à recuperação/verificação da base completa. Benefício pequeno: manter os arquivos é uma opção conservadora razoável.

Antes de aprovação/execução: snapshot externo do checkout que preserve alterações locais e arquivos não versionados; nenhuma operação de reset/clean/stash como substituto. Depois da aprovação, excluir só esses arquivos, comparar o diff com o estado pré-existente, repetir lint/tipos e conferir telas que usam ícones. Não modificar aparência de componentes ativos. Restaurar somente esses dois arquivos do snapshot caso a validação revele problema. As demais propostas ainda precisam de revisão funcional e trechos exatos antes de aprovação.

## Próxima fase em outro chat

Revisar os consumidores funcionais de A03-A06, exports auxiliares e componentes UI; examinar referências por strings/manifestos e scripts/configurações/site/CI com maior profundidade. Verificar blocos inalcançáveis além do que as ferramentas já detectam. Identificar a base completa antes de qualquer conclusão que afete releases recentes. Registrar propostas com limites exatos de função e testes relevantes. Manter a aprovação de limpeza como etapa separada; nenhuma alteração foi autorizada.

Arquivo por arquivo: `file-inventory.md` documenta o resultado de lint de todas as fontes. A aprovação de lint não comprova uso de todos os exports, integração runtime ou comportamento em hardware real.
