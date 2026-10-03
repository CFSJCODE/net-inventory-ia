# Política de segurança

O NetInventory roda como serviço do Windows, faz scans na rede local e guarda dados sobre os dispositivos dela. Levo relatos de segurança a sério.

## Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Use o reporte privado do GitHub:

1. Acesse a aba [**Security**](https://github.com/douglaspiero/net-inventory-ia/security) do repositório.
2. Clique em **Report a vulnerability**.
3. Descreva o problema, a versão afetada e, se possível, os passos para reproduzir.

Respondo assim que possível. Este é um projeto independente mantido por uma pessoa, então não há prazo garantido, mas falhas confirmadas recebem prioridade e crédito na correção (se você quiser).

## Escopo

Interessam especialmente:

- Acesso sem login, escalada de perfil (ex.: Visualizador executando ações de Operador ou Administrador) ou sessões que continuam valendo depois de o usuário ser desativado.
- Execução de comandos no servidor a partir da interface ou das ferramentas de rede.
- Vazamento da chave da OpenAI ou de dados da rede para fora do servidor (incluindo falhas no mascaramento antes do envio à IA).
- Problemas no instalador ou no serviço do Windows.

## Limitações conhecidas

- O painel é servido em **HTTP** na rede local. Use o NetInventory em redes confiáveis; não exponha a porta 3000 para a internet.
- O instalador ainda **não tem assinatura digital**. Confira o SHA-256 publicado em cada release.
