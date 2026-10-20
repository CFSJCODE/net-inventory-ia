# Painéis .NET — navegador e diagnóstico local

O painel principal é Blazor, servido pelo mesmo host .NET que recebe os agentes. No modo local, o acesso é `http://localhost:3000/`. Com Linux, endereço, porta e protocolo são configurados na seção **Host**; o usuário abre e entra no painel desse host para ver seu inventário.

## Painel no navegador

- Visão geral: agentes e estado das amostras, coleta recente/antiga/pendente, sessões e métricas disponíveis.
- Dispositivos: busca e detalhes de SO, hardware, CPU/RAM, volumes/discos, rede/IP e sessões.
- Agentes: cadastro por convite temporário e de uso único; credenciais não são compartilhadas entre hosts.
- Host/conexão: perfil local ou remoto, endereço, porta, protocolo e teste de comunicação.
- Segurança: conta por senha, sessão por cookie, antiforgery e configuração de MFA TOTP.
- Histórico: amostras persistidas em ordem cronológica; leitura atrasada não substitui a mais recente.

O host remoto continua selecionado quando não responde; a fila conserva os dados para esse destino. Configurar um endereço não publica o sistema na internet. Acesso externo depende de TLS válido, hospedagem/rede e contas autorizadas, conforme [deploy/README.md](../deploy/README.md).

## Diagnóstico WinUI deste computador

Abra `Diagnostico-Agente.cmd`. O modo local consulta o canal protegido do agente a cada cinco segundos, com timeout de dois segundos e limite de 256 KiB por diagnóstico. Não pede credencial administrativa do host. Mostra presença do agente, destino, última coleta, envio confirmado, fila pendente e ocorrência recente, além das informações locais de sistema/hardware/rede/sessões.

Se o canal não responder, mostra diagnóstico indisponível e limpa os valores da consulta; não afirma que computador ou servidor estejam offline. A coleta continua com a janela fechada. Quando executado como serviço, o canal deve estar autorizado para a conta Windows que abre o diagnóstico.

O cliente WinUI administrativo anterior permanece opcional. Suas abas de hardware/rede agora incluem CPU/RAM, volumes/discos, temperaturas com estado/origem e tráfego, velocidade, gateway/DNS. Tema, tipografia 14/20/28 e espaçamento 8/16/24 seguem `DESIGN.md`.

## Significado dos dados e status

Coleta de até cinco minutos é recente; depois, antiga; sem amostra, aguardando coleta. Esse status não é ping. Sessões console/RDP representam a observação no horário da coleta. CPU e taxas de tráfego representam o intervalo entre duas coletas; na primeira, a taxa fica indisponível. Velocidade nominal da interface não é velocidade medida da internet.

Temperatura usa um provedor LibreHardwareMonitor WMI já disponível. Sem sensor válido, mostra indisponível; zonas ACPI não são rotuladas como CPU. O agente não instala drivers automaticamente. Discos e volumes são locais; a coleta não inclui arquivos ou conteúdo dos discos.

O padrão é 30 segundos por coleta, com retentativas. A fila tem máximo de 20160 amostras e limiar de 128 MiB, que a última amostra pode ultrapassar. A janela aceita pela API é de sete dias; isso não garante sete dias completos em fila para qualquer volume de dados.

## Evidência e continuidade

Builds atuais de host, agente, WinUI e verificador passaram sem erros/avisos. A suíte atual com agente real passou em **131 verificações** de contrato, perfis, persistência, autenticação, convites, histórico, escopo, fila e reconexão, em banco isolado. Isso não substitui a conferência visual completa ou a execução real do pacote Linux.

As 10 verificações de controles do painel anterior são históricas e não comprovam aparência ou implantação da reformulação atual. Estado de serviço instalado/ativo deve ser confirmado separadamente.

Quando a compatibilidade local está configurada, `/legacy` encaminha à instalação 0.2.23 em loopback na porta 3001. Scan/topologia/SNMP/alertas/IA ainda dependem desse motor; o port completo está registrado em [migration-status.md](migration-status.md).
