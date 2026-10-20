# NetInventory 0.2.18 — versão completa com o novo Assistente IA

Data: 11/10/2026.

## Conteúdo

A versão preserva a base completa 0.2.17 preparada localmente: alertas por e-mail com perfis completo/crítico, checagem de anomalias a cada 15 segundos, métricas agrupadas e destacadas, páginas de Equipamentos e detalhes SNMP, correções de autenticação/privacidade SNMPv3 e tratamento de concorrência no scan manual. O instalador conserva as correções do runtime Node e limita a parada de processos ao próprio serviço NetInventory.

O Assistente IA agora reúne Configuração da IA, Uso e limites e Chat, na barra lateral e dentro da seção. Inclui registro persistente de metadados de consumo, filtros de período, tokens de entrada/saída, chamadas, falhas, custo informado, cache, tempo médio e detalhamento por recurso/modelo. A conversa permanece na memória do navegador ao alternar entre os submenus. [Funcionamento e limites da integração](assistente-ia.md).

Foram mantidas as permissões: administradores configuram a IA e consultam saldo/limites da chave; operadores usam o chat e consultam o consumo local; visualizadores não acessam a seção. A tabela de consumo não grava perguntas, respostas, credenciais ou dados do inventário.

## Artefato gerado

- Arquivo: `NetInventory-Setup-0.2.18.exe`.
- Tamanho: 49.895.849 bytes.
- SHA-256: `51a4b6dcc3dc25260b206996a26e1ccc9b1ff36bfe2a3f50061eb9c7003f42ed`.
- Runtime embutido: Node 24.19.0, conferido com o manifesto oficial de hashes.
- Saída do build: `installer/output/NetInventory-Setup-0.2.18.exe`.

O código consolidado foi preparado na branch `feat/assistant-ai-panel`, em um checkout separado. Os checkouts locais anteriores e seus arquivos em edição foram preservados. O executável e o arquivo de checksum foram copiados para a pasta habitual `D:\Net-Inventory\net-inventory-ia\installer\output`; as versões anteriores foram mantidas.

## Validações desta entrega

- 176 testes passaram em 29 arquivos, incluindo os 161 testes da base completa e os 15 testes novos de consumo e integração com o cliente IA.
- ESLint, validação de tipos no build e `git diff --check` passaram.
- Build standalone e compilação do Inno Setup concluídos.
- Pacote verificado sem arquivos `.env` ou bancos SQLite; metadados do aplicativo empacotado confirmam a versão 0.2.18.
- Aplicação executada com o Node e o launcher do pacote, em uma porta de teste separada, sem instalar ou alterar o serviço Windows existente.
- Banco fictício com as 14 migrações da 0.2.17: o launcher aplicou apenas a migração `20261011220000_ai_usage`, preservou usuário/dispositivo existentes e passou a registrar consumo. Após uma consulta do chat e um teste de configuração, foram conferidos dois registros e 40 tokens retornados pelo provedor simulado.
- No navegador: login do usuário fictício preservado, chat, métricas, salvamento da configuração, conversa preservada entre submenus e carregamento das páginas de Alertas e Equipamentos.

## Instalação e limites

Execute o instalador 0.2.18 com privilégio de administrador para atualizar a instalação Windows. Após concluir, recarregue o navegador para carregar o novo código. O launcher aplica as migrações pendentes ao iniciar o serviço.

O executável de instalação não foi iniciado nesta validação. A atualização efetiva do serviço Windows, o envio real de e-mail, a comunicação com equipamentos reais e a consulta com uma chave real de OpenRouter continuam pendentes. Os testes de navegador usaram banco fictício e provedor de IA local simulado. Não foi publicada uma GitHub Release nem criada uma tag de release nesta etapa.
