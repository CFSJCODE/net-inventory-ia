# Assistente IA: configuração, uso e chat

O Assistente tem três rotas: `/assistant/settings` (Configuração da IA), `/assistant/usage` (Uso e limites) e `/assistant` (Chat). O menu lateral e a navegação dentro da seção exibem os mesmos submenus, na mesma ordem. A seção fica acessível aos administradores e operadores mesmo antes de cadastrar a chave.

## Acesso e conversa

Administradores configuram o provedor e consultam créditos/limites da chave. Operadores usam o chat e consultam o consumo local. Visualizadores não acessam a seção. As ações do servidor verificam as permissões independentemente da interface.

A conversa e o rascunho permanecem na memória do navegador ao navegar entre os três submenus. Recarregar a página ou sair da seção encerra esse estado; não há gravação das mensagens no armazenamento do navegador.

## Consumo local

A tabela `AiUsage` registra provedor, modelo, recurso, resultado da chamada, tokens informados, custo em USD quando disponível, duração e código HTTP de falhas. Não contém perguntas, respostas, dados do inventário ou credenciais.

O registro cobre análises estruturadas, cada rodada do chat com ferramentas, tentativas de fallback e testes da configuração. Reaproveitamentos de cache são registrados separadamente, sem acrescentar tokens ou custo. As tentativas internas automáticas do SDK não são discriminadas. Uma falha ao registrar metadados não interrompe a resposta da IA.

Os filtros são janelas móveis de 24 horas, 7 dias, 30 dias e todo o período. As métricas locais abrangem todos os provedores/modelos usados nesta instalação. O tempo médio inclui chamadas concluídas e com falha, excluindo cache. A tabela por recurso/modelo conta também os registros de cache.

Valores ausentes aparecem como **Não informado**. Zero só aparece quando foi registrado como zero. Totais de tokens e custo podem ser parciais; o painel mostra quantas chamadas informaram esses dados. O histórico começa após aplicar a atualização e não recupera consumo anterior.

## Saldo e limites do provedor

A integração automática disponível nesta atualização é com o endpoint oficial do OpenRouter:

- `GET /api/v1/key`: teto e disponibilidade da chave, consumo acumulado/diário/mensal, renovação e cota de requisições gratuitas quando informados.
- `GET /api/v1/credits`: saldo da conta, calculado pela diferença entre créditos e consumo retornados. Esse endpoint exige permissão de gerenciamento. Se a chave não puder consultá-lo, o painel mantém os dados da chave e orienta consultar o saldo no provedor; não é necessário ampliar permissões para usar o chat.

O saldo da conta e o disponível no teto da chave são métricas distintas. Nenhuma cota fixa é presumida. As janelas do provedor são UTC e independentes do filtro de consumo local. As consultas usam a chave somente no servidor, têm timeout e não geram inferência. Configurações com endpoints alternativos não enviam a chave para o OpenRouter oficial.

Para outros provedores, o painel mantém a coleta local e informa que saldo/cotas não têm consulta automática implementada. No Ollama local, não há saldo de créditos de API.

Referências: [limites do OpenRouter](https://openrouter.ai/docs/api_reference/limits), [consulta de créditos](https://openrouter.ai/docs/api/api-reference/credits/get-credits).

## Atualização do banco

A migração aditiva `20261011220000_ai_usage` cria a tabela e índices sem alterar os registros existentes. Instalações pelo serviço aplicam migrações no fluxo normal do launcher. Em uma instalação de desenvolvimento, gere o cliente Prisma e aplique as migrações pendentes antes de iniciar o código atualizado:

```text
npx prisma generate
npx prisma migrate deploy
```
