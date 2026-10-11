# Configurações do projeto

- `env.example`: modelo local de variáveis de ambiente; copie para `.env` na raiz ao desenvolver.
- `next/`: configurações do Next.js, PostCSS e TypeScript.
- `tooling/`: configurações de ferramentas de desenvolvimento, como ESLint.

Os pequenos arquivos de entrada na raiz apenas reexportam ou estendem os arquivos desta pasta. Eles permanecem ali porque Next.js, TypeScript e ESLint os procuram por convenção. As instruções de agentes de IA estão em `../agents_ia/`.
