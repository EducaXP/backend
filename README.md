# EducaXP — backend do MVP

API REST em TypeScript e Fastify, com persistência SQLite. Atende aos fluxos de missões, acompanhamento docente, rubricas e avatares dos arquivos exportados do Stitch.

## Executar

Requisitos: Node.js 22.13+ na linha 22, ou Node.js 24+, e npm. Implementação verificada com Node.js 22.23.2. O módulo nativo `node:sqlite` pode emitir aviso de API experimental nessa versão; não exige instalar um driver nativo adicional.

No terminal, dentro da pasta `backend`:

```powershell
npm ci
Copy-Item .env.example .env
npm run seed:demo
npm run dev
```

`seed:demo` cria uma escola fictícia, a Prof.ª Maria, dois estudantes, um grupo e uma missão publicada. Exibe uma senha aleatória para `demo.maria`, o código da turma e PINs individuais. Guarde as credenciais para testar; não há senha fixa nem credenciais no repositório. Se o banco já contém usuários, o comando não modifica seus dados. Não execute o seed com dados reais.

- API: `http://127.0.0.1:3333/api/v1`
- Saúde: `http://127.0.0.1:3333/health`
- Documentação interativa: `http://127.0.0.1:3333/docs`
- OpenAPI: `http://127.0.0.1:3333/docs/json`

Também é possível executar sem modo de desenvolvimento:

```powershell
npm run build
npm start
```

O servidor carrega `.env` automaticamente quando existe. As variáveis do processo têm precedência. Configure `DATABASE_PATH` para persistir em outro local, `CORS_ORIGINS` para os endereços do frontend e `ENABLE_DOCS=false` para desativar a documentação. Em `NODE_ENV=production`, a documentação fica desativada por padrão. `HOST` usa loopback por padrão; o projeto não é publicado automaticamente.

SQLite usa um arquivo local com WAL. Durante o desenvolvimento em uma pasta sincronizada pelo OneDrive, prefira `DATABASE_PATH` em uma pasta local fora da sincronização. Não compartilhe o mesmo arquivo de banco entre máquinas ou instâncias via armazenamento de rede. A instalação inicial de dependências requer internet; executar a API e usar os modelos locais não requer serviços externos.

## O que está implementado

| Necessidade | Implementação |
| --- | --- |
| Acesso simples | Login docente e entrada estudantil por código da turma + apelido + PIN individual |
| Aparelho compartilhado | Sessões individuais; cada estudante acessa sua identidade e as entregas do próprio grupo |
| Organização da aula | Turmas, alunos, grupos e rotação dos papéis, sob controle docente |
| Missões e rubricas | Criar e editar rascunhos, publicar, consultar e encerrar |
| Trabalho sem conexão | Contrato de sincronização com UUID, idempotência, versões e histórico; armazenamento no celular depende do frontend |
| Avaliação | Revisão explícita por critério, devolutiva e reconhecimento opcional de participação |
| Participação sem celular | Professor registra a mesma entrega pelo canal `teacher_mediated`, com reconhecimento equivalente |
| Mediação | Pedidos de ajuda e respostas, combinado de pausa e contagens de entregas pendentes |
| Personalização | Catálogo cosmético, preferência de economia de animações e XP concedido pelo professor |
| Planejamento | Modelo local editável e assistente de IA configurável com revisão, autorização e limites; sem validação automática da BNCC |

## Ativar o assistente de IA

O [assistente docente](../docs/decisions/0003-assistente-ia.md) usa OpenRouter ou uma API compatível com Chat Completions e respostas estruturadas. No recurso **backend** do Coolify, configure estas variáveis de execução e faça o redeploy com o código atualizado:

~~~dotenv
AI_PROVIDER=openrouter
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=identificador-do-modelo-escolhido
AI_API_KEY=sua-chave-do-provedor
~~~

Os valores de modelo e chave acima são placeholders. Use o identificador completo do modelo no provedor e confirme suporte a JSON Schema estruturado. Não há modelo padrão para evitar escolher custo e qualidade implicitamente. Não envie a chave no chat nem coloque essas variáveis no frontend. Faça também o deploy do frontend atualizado para disponibilizar o painel.

Para outro serviço, use AI_PROVIDER=compatible e AI_BASE_URL com sua URL base HTTPS, sem /chat/completions, parâmetros de consulta ou credenciais. A URL é definida pela administração no servidor; o navegador não escolhe o destino. Parâmetros exclusivos do OpenRouter são omitidos nesse modo.

Sem AI_API_KEY, o assistente fica desativado e o planejamento local continua disponível. Com chave mas modelo/configuração inválidos, o servidor interrompe a inicialização com mensagem de configuração. enabled=true informa configuração presente; não verifica saldo, validade da chave ou disponibilidade do modelo.

Para conferir após o deploy: entre como professor, abra **Criar missão**, informe o contexto do editor e envie um pedido em **Criar com IA**. A proposta deve aparecer separada do rascunho. Peça um ajuste, aplique a proposta e revise antes de publicar. Essa verificação usa o provedor e pode consumir créditos.

O backend envia apenas o contexto de planejamento autorizado, incluindo o rascunho e até oito mensagens. O adaptador usa fetch nativo, sem dependência adicional, sem ferramentas externas e sem repetição automática. No OpenRouter solicita require_parameters=true e data_collection=deny; as condições de tratamento de dados dependem das políticas do serviço. O endpoint exige permissão docente e vínculo com a turma.

Limites: 12 pedidos/hora por professor, um simultâneo por professor, três por processo, 45 segundos, saída de até 6.000 tokens e resposta HTTP de até 128 KiB. Falhas preservam o rascunho. Contadores reiniciam com o processo e não substituem um teto de gastos na conta do provedor. Os testes exercitam o adaptador com transporte simulado; nenhuma chamada a modelo real foi executada nesta validação.

## Verificação

```powershell
npm run check
```

Executa verificação de tipos, testes de integração com SQLite real e build. Os testes usam dados fictícios e bancos isolados; não modificam o banco de desenvolvimento. Cobrem ciclo completo, autenticação, separação entre escolas/turmas/grupos, reconexão, concorrência, histórico, persistência após reinício, autorização docente, XP sem duplicação e proteção contra tentativas repetidas de login.

```powershell
npm audit --omit=dev
```

Verifica avisos conhecidos nas dependências de execução; o resultado depende da base de avisos do npm no momento da consulta.

## Estrutura

```text
src/
  app.ts                 Construção da API, autenticação e plugins
  server.ts              Inicialização HTTP e encerramento
  config.ts              Configuração por ambiente
  db.ts                  SQLite e migrações versionadas
  auth.ts                Hash de senhas, sessões e papéis
  access.ts              Autorização por escola, turma e grupo
  schemas.ts             Contratos de entrada e validação
  submissions.ts         Transação de sincronização
  planning.ts            Modelo pedagógico local
  routes/                Turmas, missões e aprendizagem
  seed.ts                Demonstração com dados fictícios
test/api.test.ts          Testes de integração
docs/API.md              Contrato e integração com o frontend
```

## Limites desta primeira implementação

- A [PWA integrada](../frontend/README.md) implementa fila offline, cache de missões, resolução visual de conflitos e troca de perfil. Consulte seus limites de armazenamento e compatibilidade antes de um piloto.
- Não há correção automática, códigos BNCC pré-validados, upload de mídia, notificações push, WebSockets, exportação para diário de classe ou painel de gestão escolar.
- A evidência é textual. Fotos e áudios do protótipo exigirão uma etapa própria de armazenamento, limites e proteção de dados.
- As missões publicadas e avaliações já registradas são imutáveis nesta versão. Uma nova versão de entrega permite nova avaliação. Fluxo de retificação de avaliação publicada está pendente.
- A composição dos grupos é fixa por turma no MVP; os papéis podem rodar. Transferência entre grupos, matrícula em várias turmas e movimentação de estudantes ficam para a próxima etapa.
- O cadastro inicial de escola e professor existe pelo seed fictício. Provisionamento real, recuperação de senha docente, gestão de consentimentos/requisitos institucionais e rotinas de exportação/exclusão ainda não estão implementados.
- Não existem métricas de atenção, presença digital, aparelhos conectados ou tempo online. A pausa é um combinado pedagógico; não bloqueia o dispositivo.
- O SQLite síncrono e o rate limiter em memória atendem a uma instância inicial. Não houve teste de carga ou validação em escola real. Um piloto exige planejamento de operação, HTTPS, backups, limites de acesso e governança de dados.

## Dados e retenção

Guarde apenas nomes de exibição/apelidos, vínculos pedagógicos e evidências necessárias. Senhas e PINs usam scrypt com salt aleatório. O banco guarda somente o hash dos tokens de sessão. Sessões expiram (12 horas por padrão), são revogadas no logout e expirações são removidas ao emitir novas sessões. Redefinir o PIN revoga todas as sessões daquele estudante.

Entregas, versões, avaliações e chaves de idempotência permanecem no banco durante a demonstração. Não há expurgo automático que possa eliminar trabalho ainda não sincronizado. A base fictícia é descartável ao encerrar a demonstração; a política de retenção e exclusão de um piloto deve ser definida antes de introduzir dados reais. Os arquivos SQLite não são criptografados pela aplicação: restrinja seu acesso pelo sistema operacional.

O backend responde com `Cache-Control: no-store`. O frontend deverá persistir offline apenas os dados selecionados, separados por identidade/grupo, e proteger rascunhos pendentes antes de sair ou trocar perfil. Não manter tokens em armazenamento acessível a scripts persistentes por conveniência: começar com tokens em memória e exigir nova entrada após recarregar; uma estratégia de sessão persistente deve ser projetada explicitamente.
