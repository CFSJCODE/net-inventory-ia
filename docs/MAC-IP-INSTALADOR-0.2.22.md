# NetInventory 0.2.22 — continuidade do cadastro pelo MAC

Data: 12/10/2026.

## Artefatos concluídos

- Instalador: `installer/output/NetInventory-Setup-0.2.22.exe`.
- Tamanho: 170.155.011 bytes, aproximadamente 162 MiB.
- Versão do produto no executável: `0.2.22`, conferida após a compilação Inno Setup.
- SHA-256: `7ee9c957b56ceba9f89f54d8076955f43c02cfdc86d7d324abc56a0c191091c2`.
- Checksum: `installer/output/NetInventory-Setup-0.2.22.exe.sha256`.
- Cópia destas notas: `installer/output/LEIA-ME-0.2.22.md`.
- Registro de origem: `installer/output/NetInventory-0.2.22-proveniencia.json`.

A entrega foi concluída sem sobrescrever os instaladores anteriores. O pacote inclui a árvore de dependências da instalação completa 0.2.21, conservando os arquivos copiados dessa base; isso amplia o tamanho em relação aos instaladores anteriores gerados a partir de um build standalone limpo.

## Comportamento

O mesmo MAC mantém o mesmo cadastro quando o IP muda. No exemplo do 4600G, a passagem de `192.168.0.92` para `192.168.0.166` atualiza o endereço e registra o evento de mudança, preservando id, nome/hostname, apelido, anotações, histórico, ligações e posição no mapa. O scan preenche hostname ausente uma vez e preserva o nome já aprendido, mesmo quando uma consulta posterior retorna `gateway.docker.internal` ou outro nome.

MACs salvos com letras minúsculas, hífens, pontos ou dois-pontos são comparados no mesmo formato. Um MAC diferente no IP antigo representa outro aparelho. Sem um MAC conhecido e observado, não há associação automática entre IPs diferentes apenas pelo nome.

## Base preservada e método de geração

A instalação existente foi verificada como 0.2.21. O checkout disponível está em uma base anterior e a pasta de fontes que produziu as entregas recentes não estava disponível. Por isso, a entrega usa o pacote completo instalado 0.2.21 como base e recompila seletivamente as funções TypeScript de persistência e identificação desta correção.

As duas cópias ativas da persistência, usadas pelas varreduras manual e agendada, receberam a atualização. Os chamadores, exports e dependências originais foram preservados. Permaneceram no pacote as páginas e recursos de Assistente IA, alertas, equipamentos e impressoras com endpoints, além das 16 migrações existentes. Não há migração de esquema nova nesta atualização.

A cópia foi validada por caminhos e tamanhos. Apenas os dois módulos de persistência e o arquivo de versão do aplicativo foram alterados. Os hashes antes/depois desses arquivos e das fontes usadas ficaram em `installer/mac-update-0.2.22/provenance.json`. Chunks antigos de instalações cumulativas, ausentes nos traces das rotas atuais, foram excluídos da cópia. O pacote foi conferido sem arquivos de ambiente ou bancos SQLite.

O instalador conserva o AppId existente e as regras da entrega completa para parar somente o serviço NetInventory. Os dados continuam em `C:\ProgramData\NetInventory`; o executável não foi iniciado nesta validação.

## Validação

- 130 testes das fontes atuais aprovados.
- Os mesmos 13 cenários de identidade executados diretamente em cada um dos dois módulos recompilados: 26 verificações aprovadas, com SQLite temporário e descoberta de rede simulada.
- Cobertura de troca de IP, nome/apelido sem alterações, grafias de MAC, aprendizado de MAC antes ausente, reutilização de IP por outro aparelho, troca simultânea de IPs, scans repetidos, duplicados legados, histórico, mapa e IPs ignorados.
- As duas rotinas completas também foram carregadas com suas dependências reais e executadas duas vezes em `127.0.0.1/32`; cada repetição manteve um único cadastro de loopback.
- Runtime embutido Node 24.19.0 executado em porta de teste e banco sintético, com escuta em loopback. Login e arquivo JavaScript da interface responderam HTTP 200; dispositivo sintético preservado, 16 migrações e integridade SQLite aprovada.
- ESLint dos arquivos TypeScript alterados, verificação de tipos das fontes atuais e verificação de espaços no diff aprovados. A checagem de tipos excluiu os artefatos antigos de `.next-installer`, que ainda referenciam uma página removida.

Os testes não trocaram o IP de um dispositivo físico nem alteraram o banco ou serviço em uso. Não foram enviadas mensagens, chamadas de IA ou e-mails de teste.

## Arquivos e reprodução

- `installer/build-mac-update.mjs`: prepara o pacote a partir da base completa 0.2.21 e gera o instalador 0.2.22.
- `installer/mac-update-lib.mjs`: recompila as funções e localiza os vínculos nos bundles, verificando a estrutura esperada.
- `installer/validate-mac-package.mjs`: verifica o runtime e as migrações em um ambiente sintético.
- `installer/validate-mac-default-bindings.mjs`: verifica os bundles completos com suas dependências reais, apenas em loopback.
- `src/lib/scan-service.test.ts`: testes das fontes e dos módulos recompilados.

A geração exige a base 0.2.21. Por padrão, lê `C:\Program Files\NetInventory`; `NETINVENTORY_PACKAGE_BASE` permite apontar para outra cópia completa dessa base. Saídas existentes não são sobrescritas. O modo `NETINVENTORY_STAGE_ONLY=1` prepara os arquivos para validação antes de compilar o executável.

A recuperação/consolidação das fontes completas posteriores à 0.2.18 permanece pendente para retornar ao fluxo normal de build integral. O comando habitual de build deste checkout antigo não reproduz os recursos completos da entrega 0.2.22.

## Aplicação da atualização

Execute `NetInventory-Setup-0.2.22.exe` como administrador e recarregue o navegador após a conclusão. A aplicação desta versão ao serviço Windows depende da execução do instalador. A instalação em uso foi mantida na 0.2.21 durante a preparação.
