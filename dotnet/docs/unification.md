# Consolidação do NetInventory

Atualizado em 14/10/2026.

## Interface e funcionamento

O acesso principal permanece em `http://localhost:3000/`. O host ASP.NET Core preserva a interface completa da instalação NetInventory 0.2.23, com seus estilos, tabelas, menus e ações. A área adicional de hardware do agente usa a mesma identidade visual. A seção de interfaces de rede foi removida dessa área; a coleta continua fornecendo a identidade de rede necessária ao vínculo dos dispositivos.

No detalhe original do dispositivo, sistema operacional e usuário logado são preenchidos pelo agente Windows. O acesso **Agente Windows · hardware e coletas** abre CPU, RAM, volumes, discos físicos, sensores disponíveis, sessões e histórico. O agente atualiza o cadastro original, identificado pelo CUID existente, em vez de criar outra ficha para o computador.

O motor de rede original ainda é usado internamente durante a migração. Ele executa somente em `127.0.0.1:3001`, supervisionado pelo host .NET, com o mesmo banco e identidade do usuário autenticado. O processo encerra junto com o host, inclusive após término abrupto. Isso preserva os recursos existentes e o visual; não significa que todos os coletores e a interface original já foram reescritos nativamente em C#.

## Banco e identidade

Após a ativação, o banco canônico é `C:/ProgramData/NetInventoryDotNet/data/server/netinventory.db`. Ele mantém as tabelas e migrações originais e recebe agentes, amostras, vínculos e extensões de segurança. O motor de rede e os serviços .NET usam esse único arquivo. Os bancos anteriores são preservados como fontes históricas e backups, não como inventários paralelos ativos.

A correlação usa MAC observado inequívoco ou o vínculo persistente do AgentId. IP e hostname, isoladamente, não mesclam dispositivos. Duplicatas confirmadas por MAC têm suas referências e históricos transferidos antes da remoção do inventário ativo; suas linhas originais ficam arquivadas privadamente. Na base verificada havia 19 MACs distintos, portanto não havia dispositivos adicionais a excluir; o agente foi vinculado a um cadastro existente.

O preparo é transacional, usa backups SQLite consistentes e recusa sobrescrever um destino existente. Eventos, scans, dados de IA, equipamentos, configurações cifradas, posições, topologia e usuários são preservados. Alterações da prévia são consideradas na consolidação final; diferenças concorrentes ficam em arquivo de auditoria privado. Conflitos de histórico cancelam a publicação.

As contas originais mantêm senha, papel, ativação e versão de sessão. Contas .NET homônimas com identidade distinta recebem alias, sem redefinir a conta original. MFA acompanha o ID estável do usuário, inclusive após renomeação. Os agentes recebem somente credenciais individuais de coleta.

## Ativação e reversão

`scripts/Unify-Local3000.cmd` solicita elevação do Windows e executa a ativação revisável. O controlador faz um novo preparo com todas as gravações interrompidas, registra os serviços, verifica contagens e integridade, confirma a identidade e uma coleta nova do agente, encerra a prévia 7444 e mantém o motor interno em loopback.

O estado confirmado fica em `.data/migration/unification-status.local.json`. A existência do pacote ou do controlador não comprova a instalação: confira esse estado e os serviços `NetInventoryDotNetHost` e `NetInventoryDotNetAgent`.

`scripts/Restore-Unified3000.ps1` restaura o serviço original, seu modo de início e o banco anterior. O banco canônico e as informações coletadas após a ativação permanecem preservados em separado; a reversão não os apaga nem os importa automaticamente no banco anterior.

## Validação e limites

Passaram 50 verificações de consolidação, 26 de autenticação, 16 de navegação, 6 de duração de processos e 131 de regressão/coleta real em banco isolado. No navegador da prévia, o painel original exibiu o Windows e o usuário coletados no cadastro existente, com login único e acesso à nova área de hardware. Armazenamento permaneceu visível e a seção de interfaces de rede ficou ausente. O preparo com os bancos reais também passou após tratar uma varredura em andamento que foi concluída na origem; resultados terminais conflitantes continuam bloqueando a consolidação.

A coleta de temperatura depende de sensores compatíveis disponíveis. Outros computadores Windows precisam ter seus próprios agentes cadastrados. O pacote Linux do host .NET existe, mas a paridade completa do motor preservado e a implantação real no Linux permanecem etapas distintas; não foram confirmadas por esta consolidação Windows.
