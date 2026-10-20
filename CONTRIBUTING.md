# Como contribuir

Obrigado por querer melhorar o NetInventory. Issues e pull requests são bem-vindos. Este guia ajuda a discutir uma mudança antes de investir tempo nela e a enviar uma contribuição que possa ser revisada com segurança.

## Antes de abrir uma issue

- Procure issues abertas e fechadas no [repositório original](https://github.com/douglaspiero/net-inventory-ia/issues) para evitar duplicatas.
- Para uma funcionalidade, abra uma issue no repositório original com o problema, quem se beneficia e como verificar o resultado. Aguarde alinhamento antes de implementar uma mudança grande ou que altere comportamento existente.
- Para um defeito, abra uma issue com passos reproduzíveis, resultado esperado e resultado observado.
- Para dúvidas de uso, consulte o README e abra uma discussão ou issue de suporte, se essa opção estiver habilitada no repositório.
- Não publique vulnerabilidades, endereços IP/MAC reais, nomes de dispositivos, capturas com dados da rede, chaves ou arquivos `.env`. Vulnerabilidades devem seguir [SECURITY.md](SECURITY.md); substitua dados de rede por exemplos fictícios.

## Preparar o ambiente

O desenvolvimento do serviço e do instalador requer Windows 10/11 e Node.js 22 ou superior. O projeto também usa npm, Prisma e SQLite. Para compilar o instalador, instale o Inno Setup 6.

```powershell
git clone https://github.com/CFSJCODE/net-inventory-ia.git
cd net-inventory-ia
npm ci
Copy-Item .env.example .env
```

Preencha `AUTH_SECRET` no `.env` com um valor aleatório local. O `.env` é ignorado pelo Git; nunca o anexe a uma issue ou commit. Gere o cliente do banco e inicie o ambiente:

```powershell
npx prisma generate
npx prisma migrate dev
npm run dev
```

Abra `http://localhost:3000`. Use uma rede de laboratório ou dados fictícios ao testar funções de descoberta e monitoramento.

## Implementar e validar

1. Use o fork `CFSJCODE/net-inventory-ia` como origem de trabalho ou faça um fork de `douglaspiero/net-inventory-ia` para sua conta e clone o fork.
2. Configure o repositório original como remoto `upstream` e mantenha sua branch `main` alinhada com ele.
3. Crie uma branch curta e específica a partir da `main` atualizada.
4. Mantenha o escopo da mudança pequeno e preserve compatibilidade com instalações existentes, incluindo dados locais e migrações SQLite.
5. Acrescente ou atualize testes quando a mudança alterar lógica observável.
6. Antes de abrir o pull request, execute:

```powershell
npm test
npm run lint
npx tsc --noEmit
npm run build
```

7. Para mudanças no instalador, também execute `npm run build:installer` em Windows com Inno Setup 6 instalado.
8. Preencha o modelo de pull request, descrevendo o problema, a solução, validação e limitações conhecidas.

## Regras para contribuições

- Não inclua credenciais, dados pessoais, dados reais da rede, bancos locais, builds, instaladores ou arquivos gerados.
- Não adicione dependências sem explicar por que são necessárias e considerar o impacto no tamanho do instalador.
- Não envie comandos de rede destrutivos ou mudanças que ampliem exposição, permissões ou coleta de dados sem explicar claramente o impacto.
- Atualize documentação e exemplos quando alterar comportamento, configuração ou requisitos.
- Mantenha mensagens, rótulos e ajuda da interface em português claro; preserve a identidade visual própria do NetInventory.
- Ao contribuir com código, você concorda que a contribuição poderá ser distribuída sob a licença MIT do projeto.

## Pull requests

Abra o pull request contra `douglaspiero/net-inventory-ia:main`, usando a branch do seu fork. O envio não garante incorporação: a manutenção revisará escopo, testes, segurança, compatibilidade e aderência ao objetivo do projeto. Não publique uma release nem altere dados/segredos de produção como parte de uma contribuição.
