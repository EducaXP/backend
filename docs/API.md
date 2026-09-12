# Contrato inicial da API

Prefixo: `/api/v1`. JSON em UTF-8. Rotas protegidas exigem `Authorization: Bearer <token>`. Datas são ISO 8601 em UTC. IDs de recursos e operações são UUIDs. A documentação em `/docs` fornece schemas de entrada; este documento detalha os retornos e o protocolo de sincronização.

## Endpoints

| Método e caminho | Acesso | Resultado principal |
| --- | --- | --- |
| `POST /auth/login` | Público | Sessão docente; body `{login,password}` |
| `POST /auth/student-session` | Público | Sessão estudantil; body `{classCode,alias,pin}` |
| `POST /auth/logout` | Autenticado | Revoga o token atual; HTTP 204 |
| `GET /me` | Autenticado | `{id,name,role,schoolId}` |
| `GET /classrooms` | Autenticado | `{items:[{id,name,paused,joinCode?}]}`; código somente ao docente |
| `POST /classrooms` | Professor | Cria turma; body `{name}`; HTTP 201 |
| `GET /classrooms/:id/students` | Professor responsável | Alunos `{id,name,alias}`; nenhum PIN |
| `POST /classrooms/:id/students` | Professor responsável | Body `{name,alias}`; cria estudante e retorna PIN uma única vez |
| `POST /classrooms/:id/students/:studentId/reset-pin` | Professor responsável | Novo PIN e revogação das sessões anteriores |
| `GET /classrooms/:id/groups` | Membro/professor | Grupos com integrantes e papéis; aluno vê apenas seu grupo |
| `POST /classrooms/:id/groups` | Professor responsável | Body `{name,members:[{studentId,role}]}` |
| `PUT /groups/:id/roles` | Professor responsável | Body `{members:[{studentId,role}]}`; mantém os integrantes |
| `PATCH /classrooms/:id/pause` | Professor responsável | Body `{paused}`; não impede sincronização |
| `GET /classrooms/:id/dashboard` | Professor responsável | Contagens pedagógicas e estado de pausa |
| `GET /classrooms/:id/missions` | Membro/professor | Missões visíveis ao perfil atual |
| `POST /classrooms/:id/missions` | Professor responsável | Conteúdo pedagógico; cria rascunho, HTTP 201 |
| `GET /missions/:id` | Membro/professor | Missão com conteúdo, versão e estado |
| `PUT /missions/:id` | Professor responsável | Body `{baseVersion,content}`; somente rascunho |
| `PATCH /missions/:id/status` | Professor responsável | Body `{baseVersion,status}`; `draft → published → closed` |
| `POST /planning/drafts` | Professor | Modelo local a partir de `{theme,subject,schoolYear,durationMinutes}` |
| `POST /sync/submissions` | Integrante/professor | Envio idempotente de uma entrega ou revisão |
| `GET /missions/:id/submissions` | Integrante/professor | Aluno vê entregas do seu grupo; professor vê as da missão |
| `GET /submissions/:id` | Integrante/professor | Versão atual, evidência e avaliação da versão atual, quando existente |
| `GET /submissions/:id/revisions` | Integrante/professor | Histórico paginado, mais recente primeiro |
| `POST /submissions/:id/evaluations` | Professor responsável | Avaliação e reconhecimento opcional |
| `POST /groups/:id/help` | Integrante estudante | Body `{message}`; HTTP 201 |
| `GET /classrooms/:id/help` | Integrante/professor | Pedidos e respostas; limitados ao grupo para estudantes |
| `PATCH /help/:id/resolve` | Professor responsável | Body `{answer}` |
| `GET /me/avatar` | Estudante | Visual atual, XP, catálogo e regra de reconhecimento |
| `PUT /me/avatar` | Estudante | Body `{itemId,ecoMode}`; valida desbloqueio no servidor |

Listagens aceitam `?limit=30&offset=0`; limite máximo de 100. O painel docente é um resumo, sem paginação. Requisições limitadas a 64 KiB; evidência textual até 12.000 caracteres. Campos extras são rejeitados. Identificadores de outra turma/grupo retornam 404 quando o perfil não tem acesso; ações exclusivas de outro papel retornam 403.

## Acesso e dispositivos compartilhados

Login retorna `{token,expiresAt}`. O código da turma sozinho não autentica nem lista estudantes. O professor cria apelidos de 2 a 24 caracteres (`a-z`, números, `_` e `-`); o servidor gera PINs de seis dígitos. O educador entrega cada PIN individualmente.

Na troca de perfil, o frontend deve tratar pendências locais, chamar logout quando conectado, limpar o token em memória e pedir as credenciais da próxima pessoa. Não enviar um `studentId` arbitrário para simular troca de identidade. Trabalho colaborativo do grupo é visível aos seus integrantes; XP e preferências de avatar são individuais. Um colega não herda o acesso ao avatar de outro por participar do mesmo grupo.

Há orçamento geral de requisições por IP e limite adicional de dez tentativas de login por conta por minuto. Colegas no mesmo Wi-Fi têm contadores de login individuais. Um HTTP 429 inclui `Retry-After`. Os contadores são locais à instância e reiniciam com o processo.

## Missões e rubricas

O retorno de missão é `{id,classroomId,status,version,content,bnccVerification,createdAt}`. A primeira versão é 1. Cada edição/publicação/encerramento incrementa a versão. Um rascunho não aparece para estudantes.

`content` contém título, objetivo, componente curricular, ano, duração, alternativa sem dispositivo, etapas e rubrica. Etapas possuem `{title,instructions,mode}` com `screen` ou `off_screen`. A rubrica contém critérios `{id,title,levels}`, cada um com quatro descrições ordenadas dos níveis 0 a 3. IDs dos critérios são únicos por missão.

`bnccReference`, quando enviada pelo professor, guarda `{code,sourceUrl}`. A API não busca essa URL nem verifica o código. `bnccVerification` permanece `pending`; o frontend deve mostrar “Alinhamento pendente de verificação”, sem selo de validação. O planejamento local não inclui códigos presumidos.

## Sincronização de entregas

Antes de ficar offline, o frontend deve obter sessão, missão e grupo; baixar o conteúdo e preparar armazenamento local por identidade. A API não torna o navegador offline por si só.

Uma operação representa uma entrega completa, não um evento de clique ou de atenção:

```json
{
  "operationId": "aa5d32a5-423c-475b-978d-3fc1a5d2c571",
  "submissionId": "b44c720e-849c-43df-a994-5c45b6b0ea8e",
  "missionId": "SUBSTITUA_PELO_UUID_DA_MISSAO",
  "groupId": "SUBSTITUA_PELO_UUID_DO_GRUPO",
  "baseVersion": 0,
  "evidence": "Comparamos três medições e justificamos a conclusão.",
  "reflection": "Dividimos o registro e a apresentação.",
  "completedSteps": [0, 1, 2],
  "channel": "digital"
}
```

`missionId` e `groupId` devem ser UUIDs reais retornados pela API; os textos acima são marcadores. `completedSteps` usa índices a partir de zero.

1. Gerar `submissionId` estável para o par grupo/missão e `operationId` único para a operação. Guardar payload e IDs juntos no aparelho.
2. Para criar, usar `baseVersion: 0`. Para revisar, manter `submissionId`, gerar nova `operationId` e usar a versão atual como `baseVersion`.
3. Processar sequencialmente as operações de uma mesma entrega. Repetir exatamente o payload e `operationId` em timeout ou perda de conexão. O retorno é `{submission,replayed}`; uma repetição bem-sucedida retorna a resposta original com `replayed:true`.
4. Marcar como sincronizado apenas após resposta bem-sucedida. Uma operação repetida pode retornar versão anterior à atual; não substituir um estado local mais recente por esse recibo.
5. Em HTTP 401, preservar a fila e pedir nova autenticação da mesma identidade. Não reenviar automaticamente a fila de outra pessoa após troca de perfil.
6. Em HTTP 409 `VERSION_CONFLICT`, manter o rascunho local e usar `error.details.current` para comparar as versões. Após resolução pelo usuário, enviar uma nova operação baseada na versão atual. Conflitos rejeitados não são armazenados pelo servidor.
7. Em HTTP 409 `IDEMPOTENCY_KEY_REUSED`, a operação mudou de conteúdo sem mudar de ID. Corrigir a fila; não repetir indefinidamente.
8. Outras falhas de validação/permissão exigem correção. Para 429/5xx/falhas de rede, usar espera progressiva com variação e respeitar `Retry-After`.

As chaves de idempotência pertencem à identidade autenticada. O grupo possui uma entrega por missão. Duas pessoas que criam a primeira entrega simultaneamente recebem um sucesso e um conflito; a segunda deve adotar o `submissionId` retornado no conflito após revisar o conteúdo.

Transações gravam versão, histórico e recibo de idempotência juntos. Nenhum reenvio soma XP. Após encerramento da missão, novas entregas continuam aceitas com `receivedAfterClosure:true`, para revisão docente. Pausar a turma também não bloqueia entregas pendentes. Não inferimos quando uma atividade aconteceu offline.

## Avaliação e reconhecimento

```json
{
  "submissionVersion": 1,
  "feedback": "As evidências apoiam a conclusão. Expliquem também os limites da medição.",
  "scores": [
    { "criterionId": "evidence", "level": 2 },
    { "criterionId": "collaboration", "level": 2 }
  ],
  "recognizeParticipation": true
}
```

Devem ser enviados exatamente os critérios da rubrica publicada. Avaliar uma versão antiga retorna conflito. O retorno é `{evaluation,awardedStudents}`. Avaliação já publicada retorna 409 `ALREADY_EVALUATED`, incluindo a avaliação existente, para reconhecer uma tentativa cujo resultado anterior se perdeu.

Com `recognizeParticipation:true`, cada integrante recebe 100 XP uma única vez por missão, seja a entrega digital ou registrada pelo professor. O valor não depende do nível da rubrica, tempo de foco, presença online ou quantidade de revisões. `false` publica apenas a devolutiva. XP não é gasto; apenas libera itens cosméticos com critérios transparentes.

## Erros

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Existe uma versão mais recente. Preserve o rascunho local e revise as diferenças.",
    "details": { "current": {} }
  }
}
```

`details` é opcional. O frontend deve tratar `code`, apresentar `message` e preservar o trabalho do usuário. Não usar o texto da mensagem como identificador de regra. Erros internos não expõem SQL, credenciais ou evidências.

## Correspondência com o Stitch

- Hub do aluno: `/me`, `/classrooms`, missões, grupos, entregas e ajuda. O cronômetro pode ser local e opcional; não gera evidência de foco nem XP.
- Painel docente: `/dashboard`, grupos, entregas, ajuda e pausa. Substituir “conectados” e “% de foco” por alunos matriculados, entregas pendentes e dúvidas abertas.
- Assistente: `/planning/drafts`, edição de missão e avaliações. Mostrar “Modelo local” enquanto não houver provedor de IA. Remover estimativas não medidas de economia de tempo.
- Avatar: `/me/avatar`. Substituir cristais por permanência online pelo reconhecimento pedagógico documentado. Não exibir ranking, sequências obrigatórias ou níveis já preenchidos com dados fictícios.

Nesta etapa o painel atualiza por requisição HTTP. Quando implementado no frontend, usar atualização manual ou consulta moderada, interrompendo-a sem rede. Não criar telemetria de presença para simular “tempo real”.


## Assistente de planejamento

GET /planning/assistant/status exige professor e retorna {enabled:boolean}. Indica configuração presente; não consulta saldo ou disponibilidade do modelo.

POST /planning/assistant exige professor responsável pela turma. Corpo: classroomId, instruction (até 4.000 caracteres), subject, schoolYear, durationMinutes (1–240), resources (até 1.500), currentDraft opcional (MissionContent sem bnccReference) e history opcional (até oito objetos {role: user|assistant, content}, 3.000 caracteres por mensagem).

Retorno: {mode:"ai", requiresTeacherReview:true, bnccVerification:"pending", reply, content}. A operação apenas propõe conteúdo; não salva nem publica missão. A interface pode aplicar content ao editor e usar as rotas normais após revisão docente. O identificador da turma é usado na autorização e excluído do contexto enviado ao agente.

Falhas: 503 AI_NOT_CONFIGURED, AI_CONFIGURATION_ERROR, AI_CREDITS_REQUIRED, AI_MODEL_UNAVAILABLE ou AI_PROVIDER_BUSY; 502 AI_INVALID_RESPONSE/AI_UNAVAILABLE; 504 AI_TIMEOUT; 413 AI_CONTEXT_TOO_LARGE; 429 AI_BUSY ou AI_BUDGET_REACHED (este último inclui Retry-After). Há também erros usuais de autenticação, autorização e validação. Não repetir geração automaticamente. Ver [limites e configuração](../README.md#ativar-o-assistente-de-ia).


### Questões de investigação

MissionContent aceita questions opcional (1–10 objetos {id,topic,prompt}, IDs únicos). A saída do assistente exige questions. O pedido de planejamento aceita topics opcional (até dez textos); a resposta deve cobrir os tópicos informados.

POST /sync/submissions aceita answers opcional (até dez objetos {questionId,text}, texto não vazio de até 2.000 caracteres). Em missões com questions, cada pergunta precisa de exatamente uma resposta e evidence pode ser vazio. Entregas incompletas retornam 422 INCOMPLETE_ANSWERS. Sem perguntas, evidence deve conter texto; respostas extras ou texto vazio retornam 422 INVALID_EVIDENCE. Campos malformados continuam retornando 400.

Answers aparece na entrega, nas revisões e na versão atual de um conflito. A ordem de answers não altera a assinatura idempotente. A sugestão local de feedback não cria nova rota; publicação usa POST /submissions/:id/evaluations após revisão.
