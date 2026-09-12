import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { digest, hashPassword, issueSession } from "../src/auth.js";
import type { PlanningAgent, PlanningContext } from "../src/planning-agent.js";
import { planningTemplate } from "../src/planning.js";
import { buildTestApp as buildApp } from "./support.js";
type HTTPMethods = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
async function fixture(
  t: TestContext,
  databasePath?: string,
  planningAgent?: PlanningAgent,
) {
  const { app, db } = await buildApp({
    databasePath,
    planningAgent,
    enableDocs: true,
    rateLimitMax: 1000,
    corsOrigins: ["http://localhost:5173"],
  });
  t.after(() => app.close());
  const school = randomUUID(),
    otherSchool = randomUUID();
  await db.run("INSERT INTO schools VALUES($1,$2)", school, "Escola fictícia");
  await db.run(
    "INSERT INTO schools VALUES($1,$2)",
    otherSchool,
    "Outra escola fictícia",
  );
  const hash = await hashPassword("test-password-123");
  const addTeacher = async (login: string, schoolId: string) => {
    const id = randomUUID();
    await db.run(
      "INSERT INTO users(id,school_id,role,name,login,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
      id,
      schoolId,
      "teacher",
      login,
      login,
      hash,
    );
    return { id, token: (await issueSession(db, id, 12)).token };
  };
  const maria = await addTeacher("maria", school),
    otherTeacher = await addTeacher("outro", school),
    external = await addTeacher("externo", otherSchool);
  const send = (
    method: HTTPMethods,
    path: string,
    token?: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  const ok = async (
    method: HTTPMethods,
    path: string,
    token: string,
    payload?: object,
    status = 200,
  ) => {
    const response = await send(method, path, token, payload);
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const classroom = await ok(
    "POST",
    "/classrooms",
    maria.token,
    { name: "9º A" },
    201,
  );
  const otherClass = await ok(
    "POST",
    "/classrooms",
    otherTeacher.token,
    { name: "8º B" },
    201,
  );
  const createStudent = async (alias: string) => {
    const user = await ok(
      "POST",
      `/classrooms/${classroom.id}/students`,
      maria.token,
      { name: alias, alias },
      201,
    );
    return { ...user, token: (await issueSession(db, user.id, 12)).token };
  };
  const enzo = await createStudent("enzo"),
    valentina = await createStudent("valentina"),
    lucas = await createStudent("lucas");
  const group = await ok(
    "POST",
    `/classrooms/${classroom.id}/groups`,
    maria.token,
    {
      name: "Ipê",
      members: [
        { studentId: enzo.id, role: "Investigar" },
        { studentId: valentina.id, role: "Registrar" },
      ],
    },
    201,
  );
  const otherGroup = await ok(
    "POST",
    `/classrooms/${classroom.id}/groups`,
    maria.token,
    { name: "Jatobá", members: [{ studentId: lucas.id, role: "Apresentar" }] },
    201,
  );
  const content = planningTemplate({
    theme: "consumo de água",
    subject: "Matemática",
    schoolYear: "9º ano",
    durationMinutes: 30,
  });
  const draft = await ok(
    "POST",
    `/classrooms/${classroom.id}/missions`,
    maria.token,
    content,
    201,
  );
  const mission = await ok(
    "PATCH",
    `/missions/${draft.id}/status`,
    maria.token,
    { baseVersion: 1, status: "published" },
  );
  const operation = () => ({
    operationId: randomUUID(),
    submissionId: randomUUID(),
    missionId: mission.id,
    groupId: group.id,
    baseVersion: 0,
    evidence: "Nossa hipótese foi comparada com três medições.",
    reflection: "Dividimos o registro e a discussão.",
    completedSteps: [0, 1, 2],
    channel: "digital",
  });
  const evaluation = (submissionVersion = 1) => ({
    submissionVersion,
    feedback: "As evidências sustentam a conclusão.",
    scores: content.rubric.map((c) => ({ criterionId: c.id, level: 2 })),
    recognizeParticipation: true,
  });
  return {
    app,
    db,
    send,
    ok,
    maria,
    otherTeacher,
    external,
    classroom,
    otherClass,
    enzo,
    valentina,
    lucas,
    group,
    otherGroup,
    content,
    mission,
    operation,
    evaluation,
  };
}
test("ciclo pedagógico completo: entrega, avaliação humana, recompensa equivalente e avatar", async (t) => {
  const f = await fixture(t);
  const body = f.operation();
  const result = await f.ok("POST", "/sync/submissions", f.enzo.token, body);
  assert.equal(result.submission.version, 1);
  const viewed = await f.ok(
    "GET",
    `/submissions/${body.submissionId}`,
    f.valentina.token,
  );
  assert.equal(viewed.evidence, body.evidence);
  assert.equal(viewed.evaluation, null);
  const review = await f.ok(
    "POST",
    `/submissions/${body.submissionId}/evaluations`,
    f.maria.token,
    f.evaluation(),
  );
  assert.equal(review.awardedStudents, 2);
  for (const member of [f.enzo, f.valentina]) {
    assert.equal((await f.ok("GET", "/me/avatar", member.token)).xp, 100);
  }
  await f.ok("PUT", "/me/avatar", f.enzo.token, {
    itemId: "headphones",
    ecoMode: true,
  });
  assert.equal(
    (await f.ok("GET", "/me/avatar", f.enzo.token)).itemId,
    "headphones",
  );
  const dashboard = await f.ok(
    "GET",
    `/classrooms/${f.classroom.id}/dashboard`,
    f.maria.token,
  );
  assert.equal(dashboard.submissions, 1);
  assert.equal(dashboard.awaitingReview, 0);
  assert.equal("focus" in dashboard, false);
});
test("login docente e estudantil, logout e expiração da sessão", async (t) => {
  const f = await fixture(t);
  const login = await f.send("POST", "/auth/login", undefined, {
    login: "maria",
    password: "test-password-123",
  });
  assert.equal(login.statusCode, 200);
  const student = await f.send("POST", "/auth/student-session", undefined, {
    classCode: f.classroom.joinCode,
    alias: "enzo",
    pin: f.enzo.pin,
  });
  assert.equal(student.statusCode, 200);
  const token = student.json().token;
  const me = await f.ok("GET", "/me", token);
  assert.equal(me.id, f.enzo.id);
  assert.equal("password_hash" in me, false);
  assert.equal((await f.send("POST", "/auth/logout", token)).statusCode, 204);
  assert.equal((await f.send("GET", "/me", token)).statusCode, 401);
  await dbExpire();
  assert.equal((await f.send("GET", "/me", f.valentina.token)).statusCode, 401);
  async function dbExpire() {
    await f.db.run(
      "UPDATE sessions SET expires_at=0 WHERE token_hash=$1",
      digest(f.valentina.token),
    );
  }
  assert.equal((await f.send("GET", "/classrooms")).statusCode, 401);
  assert.equal((await f.send("GET", "/me", "fake")).statusCode, 401);
});
test("código da turma sozinho não revela perfis; PIN incorreto não autentica", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.send("GET", `/classrooms/${f.classroom.id}/students`)).statusCode,
    401,
  );
  const badPin = f.enzo.pin === "000000" ? "111111" : "000000";
  const response = await f.send("POST", "/auth/student-session", undefined, {
    classCode: f.classroom.joinCode,
    alias: "enzo",
    pin: badPin,
  });
  assert.equal(response.statusCode, 401);
  assert.equal(
    (
      await f.send("POST", "/auth/student-session", undefined, {
        classCode: "UNKNOWN",
        alias: "enzo",
        pin: f.enzo.pin,
      })
    ).statusCode,
    401,
  );
});
test("educadores de outras turmas e escolas e estudantes sem vínculo não acessam dados", async (t) => {
  const f = await fixture(t);
  for (const actor of [f.otherTeacher, f.external]) {
    for (const path of [
      `/classrooms/${f.classroom.id}/students`,
      `/missions/${f.mission.id}`,
      `/classrooms/${f.classroom.id}/dashboard`,
    ]) {
      assert.equal(
        (await f.send("GET", path, actor.token)).statusCode,
        404,
        path,
      );
    }
  }
  assert.equal(
    (
      await f.send(
        "GET",
        `/classrooms/${f.otherClass.id}/missions`,
        f.enzo.token,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.send("POST", "/classrooms", f.enzo.token, { name: "Inválida" }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await f.send(
        "GET",
        `/classrooms/${f.classroom.id}/students`,
        f.enzo.token,
      )
    ).statusCode,
    403,
  );
});
test("grupos isolam entregas e pedidos de ajuda, incluindo estudantes na mesma turma", async (t) => {
  const f = await fixture(t),
    body = f.operation();
  await f.ok("POST", "/sync/submissions", f.enzo.token, body);
  assert.equal(
    (await f.send("GET", `/submissions/${body.submissionId}`, f.lucas.token))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.send("POST", "/sync/submissions", f.lucas.token, body)).statusCode,
    404,
  );
  assert.equal(
    (await f.ok("GET", `/missions/${f.mission.id}/submissions`, f.lucas.token))
      .items.length,
    0,
  );
  assert.equal(
    (await f.ok("GET", `/classrooms/${f.classroom.id}/groups`, f.enzo.token))
      .items.length,
    1,
  );
  const help = await f.ok(
    "POST",
    `/groups/${f.group.id}/help`,
    f.enzo.token,
    { message: "Como comparamos as medidas?" },
    201,
  );
  assert.equal(
    (await f.ok("GET", `/classrooms/${f.classroom.id}/help`, f.lucas.token))
      .items.length,
    0,
  );
  assert.equal(
    (
      await f.send("PATCH", `/help/${help.id}/resolve`, f.otherTeacher.token, {
        answer: "Resposta",
      })
    ).statusCode,
    404,
  );
  await f.ok("PATCH", `/help/${help.id}/resolve`, f.maria.token, {
    answer: "Observem a unidade usada em cada medição.",
  });
  assert.ok(
    (await f.ok("GET", `/classrooms/${f.classroom.id}/help`, f.valentina.token))
      .items[0].resolvedAt,
  );
});
test("missões em rascunho são privadas, têm controle de versão e publicação congela a rubrica", async (t) => {
  const f = await fixture(t);
  const draft = await f.ok(
    "POST",
    `/classrooms/${f.classroom.id}/missions`,
    f.maria.token,
    f.content,
    201,
  );
  assert.equal(
    (await f.send("GET", `/missions/${draft.id}`, f.enzo.token)).statusCode,
    404,
  );
  assert.equal(
    (await f.ok("GET", `/classrooms/${f.classroom.id}/missions`, f.enzo.token))
      .items.length,
    1,
  );
  await f.ok("PUT", `/missions/${draft.id}`, f.maria.token, {
    baseVersion: 1,
    content: { ...f.content, title: "Revisada" },
  });
  assert.equal(
    (
      await f.send("PUT", `/missions/${draft.id}`, f.maria.token, {
        baseVersion: 1,
        content: f.content,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.send("PUT", `/missions/${f.mission.id}`, f.maria.token, {
        baseVersion: 2,
        content: f.content,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.send("PATCH", `/missions/${draft.id}/status`, f.maria.token, {
        baseVersion: 2,
        status: "closed",
      })
    ).statusCode,
    409,
  );
});
test("reenvios idempotentes preservam uma única entrega mesmo com ordem diferente no JSON", async (t) => {
  const f = await fixture(t),
    body = f.operation();
  await f.ok("POST", "/sync/submissions", f.enzo.token, body);
  const reversed = Object.fromEntries(Object.entries(body).reverse());
  const retry = await f.ok("POST", "/sync/submissions", f.enzo.token, reversed);
  assert.equal(retry.replayed, true);
  assert.equal(retry.submission.version, 1);
  assert.equal(
    (await f.db.get<{
      n: number;
    }>("SELECT count(*) n FROM submissions"))!.n,
    1,
  );
  assert.equal(
    (await f.db.get<{
      n: number;
    }>("SELECT count(*) n FROM submission_revisions"))!.n,
    1,
  );
  const changed = await f.send("POST", "/sync/submissions", f.enzo.token, {
    ...body,
    evidence: "Outra resposta",
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, "IDEMPOTENCY_KEY_REUSED");
});
test("edições concorrentes retornam a versão atual, sem perda de histórico", async (t) => {
  const f = await fixture(t),
    body = f.operation();
  await f.ok("POST", "/sync/submissions", f.enzo.token, body);
  const next = {
    ...body,
    operationId: randomUUID(),
    baseVersion: 1,
    evidence: "Versão revista",
  };
  const competing = {
    ...next,
    operationId: randomUUID(),
    evidence: "Outra conclusão",
  };
  const responses = await Promise.all([
    f.send("POST", "/sync/submissions", f.enzo.token, next),
    f.send("POST", "/sync/submissions", f.valentina.token, competing),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const conflict = responses.find((r) => r.statusCode === 409)!.json();
  assert.equal(conflict.error.details.current.version, 2);
  const history = await f.ok(
    "GET",
    `/submissions/${body.submissionId}/revisions`,
    f.maria.token,
  );
  assert.deepEqual(
    history.items.map((r: { version: number }) => r.version),
    [2, 1],
  );
  assert.equal(history.items[1].content.evidence, body.evidence);
});
test("reconexão após pausa e encerramento recebe trabalho e sinaliza atraso", async (t) => {
  const f = await fixture(t);
  await f.ok("PATCH", `/classrooms/${f.classroom.id}/pause`, f.maria.token, {
    paused: true,
  });
  await f.ok("PATCH", `/missions/${f.mission.id}/status`, f.maria.token, {
    baseVersion: 2,
    status: "closed",
  });
  const response = await f.ok(
    "POST",
    "/sync/submissions",
    f.enzo.token,
    f.operation(),
  );
  assert.equal(response.submission.receivedAfterClosure, true);
});
test("registros mediados recebem o mesmo XP e estudantes não podem se passar pelo professor", async (t) => {
  const f = await fixture(t);
  const body = { ...f.operation(), channel: "teacher_mediated" };
  assert.equal(
    (await f.send("POST", "/sync/submissions", f.enzo.token, body)).statusCode,
    403,
  );
  await f.ok("POST", "/sync/submissions", f.maria.token, body);
  await f.ok(
    "POST",
    `/submissions/${body.submissionId}/evaluations`,
    f.maria.token,
    f.evaluation(),
  );
  assert.equal((await f.ok("GET", "/me/avatar", f.enzo.token)).xp, 100);
});
test("avaliação exige docente, versão atual e critérios válidos; recompensas não se repetem", async (t) => {
  const f = await fixture(t),
    body = f.operation();
  await f.ok("POST", "/sync/submissions", f.enzo.token, body);
  const path = `/submissions/${body.submissionId}/evaluations`;
  assert.equal(
    (await f.send("POST", path, f.enzo.token, f.evaluation())).statusCode,
    403,
  );
  assert.equal(
    (await f.send("POST", path, f.otherTeacher.token, f.evaluation()))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.send("POST", path, f.maria.token, {
        ...f.evaluation(),
        scores: [{ criterionId: "fake", level: 2 }],
      })
    ).statusCode,
    422,
  );
  await f.ok("POST", path, f.maria.token, f.evaluation());
  assert.equal(
    (await f.send("POST", path, f.maria.token, f.evaluation())).statusCode,
    409,
  );
  await f.ok("POST", "/sync/submissions", f.enzo.token, {
    ...body,
    operationId: randomUUID(),
    baseVersion: 1,
    evidence: "Aprimoramos a conclusão.",
  });
  assert.equal(
    (await f.send("POST", path, f.maria.token, f.evaluation(1))).statusCode,
    409,
  );
  const result = await f.ok("POST", path, f.maria.token, f.evaluation(2));
  assert.equal(result.awardedStudents, 0);
  assert.equal((await f.ok("GET", "/me/avatar", f.valentina.token)).xp, 100);
});
test("sem reconhecimento explícito não há XP; cliente não desbloqueia item por conta própria", async (t) => {
  const f = await fixture(t),
    body = f.operation();
  await f.ok("POST", "/sync/submissions", f.enzo.token, body);
  await f.ok(
    "POST",
    `/submissions/${body.submissionId}/evaluations`,
    f.maria.token,
    { ...f.evaluation(), recognizeParticipation: false },
  );
  assert.equal((await f.ok("GET", "/me/avatar", f.enzo.token)).xp, 0);
  assert.equal(
    (
      await f.send("PUT", "/me/avatar", f.enzo.token, {
        itemId: "cape",
        ecoMode: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.send("PUT", "/me/avatar", f.enzo.token, {
        itemId: "basic",
        ecoMode: true,
        xp: 9999,
      })
    ).statusCode,
    400,
  );
});
test("schema rejeita telemetria de foco, campos desconhecidos e conteúdo excessivo", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.send("POST", "/sync/submissions", f.enzo.token, {
        ...f.operation(),
        focusPercentage: 100,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.send("POST", "/sync/submissions", f.enzo.token, {
        ...f.operation(),
        evidence: "   ",
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await f.send("POST", "/sync/submissions", f.enzo.token, {
        ...f.operation(),
        evidence: "a".repeat(70000),
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (
      await f.send("POST", "/sync/submissions", f.enzo.token, {
        ...f.operation(),
        completedSteps: [11],
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await f.send(
        "POST",
        `/classrooms/${f.classroom.id}/missions`,
        f.maria.token,
        { ...f.content, rubric: [f.content.rubric[0], f.content.rubric[0]] },
      )
    ).statusCode,
    422,
  );
});
test("grupos inválidos e aliases duplicados não deixam registros parciais", async (t) => {
  const f = await fixture(t);
  const before = (await f.db.get<{
    n: number;
  }>("SELECT count(*) n FROM users"))!.n;
  assert.equal(
    (
      await f.send(
        "POST",
        `/classrooms/${f.classroom.id}/students`,
        f.maria.token,
        { name: "Outro", alias: "enzo" },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.db.get<{
      n: number;
    }>("SELECT count(*) n FROM users"))!.n,
    before,
  );
  assert.equal(
    (
      await f.send(
        "POST",
        `/classrooms/${f.classroom.id}/groups`,
        f.maria.token,
        {
          name: "Inválido",
          members: [
            { studentId: f.enzo.id, role: "Registrar" },
            { studentId: randomUUID(), role: "Apresentar" },
          ],
        },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.db.get<{
      n: number;
    }>("SELECT count(*) n FROM groups"))!.n,
    2,
  );
});
test("redefinição do PIN exige professor responsável e revoga sessões antigas", async (t) => {
  const f = await fixture(t);
  const path = `/classrooms/${f.classroom.id}/students/${f.enzo.id}/reset-pin`;
  assert.equal(
    (await f.send("POST", path, f.otherTeacher.token)).statusCode,
    404,
  );
  const result = await f.ok("POST", path, f.maria.token);
  assert.match(result.pin, /^\d{6}$/);
  assert.equal((await f.send("GET", "/me", f.enzo.token)).statusCode, 401);
  const response = await f.send("POST", "/auth/student-session", undefined, {
    classCode: f.classroom.joinCode,
    alias: "enzo",
    pin: result.pin,
  });
  assert.equal(response.statusCode, 200);
});
test("limite de tentativas por conta não bloqueia colegas no mesmo Wi-Fi", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const response = await f.send("POST", "/auth/student-session", undefined, {
      classCode: f.classroom.joinCode,
      alias: "enzo",
      pin: "000000",
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(
    (
      await f.send("POST", "/auth/student-session", undefined, {
        classCode: f.classroom.joinCode,
        alias: "enzo",
        pin: "000000",
      })
    ).statusCode,
    429,
  );
  assert.equal(
    (
      await f.send("POST", "/auth/student-session", undefined, {
        classCode: f.classroom.joinCode,
        alias: "valentina",
        pin: f.valentina.pin,
      })
    ).statusCode,
    200,
  );
});
test("documentação, paginação, cabeçalhos e planejamento local correspondem ao backend", async (t) => {
  const f = await fixture(t);
  const docs = await f.app.inject("/docs/json");
  assert.equal(docs.statusCode, 200);
  assert.ok(docs.json().paths["/api/v1/sync/submissions"]);
  assert.deepEqual(docs.json().paths["/api/v1/me"].get.security, [
    { bearerAuth: [] },
  ]);
  const response = await f.send("GET", "/me", f.enzo.token);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(
    (
      await f.ok(
        "GET",
        `/classrooms/${f.classroom.id}/students?limit=1&offset=1`,
        f.maria.token,
      )
    ).items.length,
    1,
  );
  assert.equal(
    (await f.send("GET", "/classrooms?limit=5000", f.maria.token)).statusCode,
    400,
  );
  const draft = await f.ok("POST", "/planning/drafts", f.maria.token, {
    theme: "energia",
    subject: "Ciências",
    schoolYear: "7º ano",
    durationMinutes: 20,
  });
  assert.equal(draft.mode, "local_template");
  assert.equal(draft.bnccVerification, "pending");
  assert.equal(draft.requiresTeacherReview, true);
  assert.equal("bnccReference" in draft.content, false);
  assert.equal(
    (
      await f.send("POST", "/planning/drafts", f.enzo.token, {
        theme: "energia",
        subject: "Ciências",
        schoolYear: "7º ano",
        durationMinutes: 20,
      })
    ).statusCode,
    403,
  );
});
test("PostgreSQL preserva dados, sessões e idempotência após reiniciar o backend", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "educaxp-test-"));
  const path = join(directory, "test.db");
  const f = await fixture(t, path);
  const body = f.operation();
  await f.ok("POST", "/sync/submissions", f.enzo.token, body);
  await f.app.close();
  const reopened = await buildApp({ databasePath: path });
  try {
    const response = await reopened.app.inject({
      method: "POST",
      url: "/api/v1/sync/submissions",
      headers: { authorization: `Bearer ${f.enzo.token}` },
      payload: body,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().replayed, true);
    assert.equal(response.json().submission.version, 1);
  } finally {
    await reopened.app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("educaxp-test-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
test("rotação de papéis mantém integrantes e não permite trocar o destinatário das recompensas", async (t) => {
  const f = await fixture(t);
  await f.ok("PUT", `/groups/${f.group.id}/roles`, f.maria.token, {
    members: [
      { studentId: f.enzo.id, role: "Registrar" },
      { studentId: f.valentina.id, role: "Investigar" },
    ],
  });
  assert.equal(
    (
      await f.send("PUT", `/groups/${f.group.id}/roles`, f.maria.token, {
        members: [
          { studentId: f.enzo.id, role: "Registrar" },
          { studentId: f.lucas.id, role: "Investigar" },
        ],
      })
    ).statusCode,
    422,
  );
  const groups = await f.ok(
    "GET",
    `/classrooms/${f.classroom.id}/groups`,
    f.valentina.token,
  );
  assert.equal(
    groups.items[0].members.find((m: { id: string }) => m.id === f.valentina.id)
      .role,
    "Investigar",
  );
});
const investigationQuestions = [
  {
    id: "q1",
    topic: "Porcentagem",
    prompt:
      "Um produto custa R$ 100 e tem 20% de desconto. Qual é o preço final? Expliquem o cálculo.",
  },
  {
    id: "q2",
    topic: "Comparação",
    prompt: "Que evidência vocês usariam para escolher entre duas ofertas?",
  },
];
const planningRequest = (classroomId: string) => ({
  classroomId,
  instruction: "Crie uma atividade de porcentagem em equipes.",
  subject: "Matemática",
  schoolYear: "9º ano",
  durationMinutes: 30,
  resources: "Papel e um celular por equipe",
  history: [],
});
test("assistente desativado preserva o planejamento local e exige acesso docente", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.ok("GET", "/planning/assistant/status", f.maria.token),
    { enabled: false },
  );
  assert.equal(
    (await f.send("GET", "/planning/assistant/status", f.enzo.token))
      .statusCode,
    403,
  );
  const response = await f.send(
    "POST",
    "/planning/assistant",
    f.maria.token,
    planningRequest(f.classroom.id),
  );
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /AI_NOT_CONFIGURED/);
});
test("assistente isola turmas, limita contexto e retorna proposta sem publicar missão", async (t) => {
  const received: PlanningContext[] = [];
  const f = await fixture(t, undefined, async (context) => {
    received.push(context);
    return {
      reply: "Proposta simulada para teste.",
      content: {
        ...planningTemplate({ ...context, theme: "porcentagem" }),
        questions: investigationQuestions,
      },
    };
  });
  const body = { ...planningRequest(f.classroom.id), currentDraft: f.content };
  assert.equal(
    (await f.send("POST", "/planning/assistant", f.enzo.token, body))
      .statusCode,
    403,
  );
  assert.equal(
    (await f.send("POST", "/planning/assistant", f.otherTeacher.token, body))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.send("POST", "/planning/assistant", f.external.token, body))
      .statusCode,
    404,
  );
  assert.equal(received.length, 0);
  const result = await f.ok("POST", "/planning/assistant", f.maria.token, body);
  assert.equal(result.requiresTeacherReview, true);
  assert.equal(result.bnccVerification, "pending");
  assert.equal(result.content.bnccReference, undefined);
  assert.ok(received[0]);
  assert.deepEqual(Object.keys(received[0]).sort(), [
    "currentDraft",
    "durationMinutes",
    "history",
    "instruction",
    "resources",
    "schoolYear",
    "subject",
  ]);
  assert.equal(
    (
      await f.ok(
        "GET",
        "/classrooms/" + f.classroom.id + "/missions",
        f.maria.token,
      )
    ).items.length,
    1,
  );
  const excessive = {
    ...body,
    history: Array.from({ length: 9 }, () => ({
      role: "user",
      content: "teste",
    })),
  };
  assert.equal(
    (await f.send("POST", "/planning/assistant", f.maria.token, excessive))
      .statusCode,
    400,
  );
  assert.equal(received.length, 1);
});
test("assistente recusa respostas incompletas, critérios repetidos e BNCC não verificada", async (t) => {
  let result: unknown;
  const f = await fixture(t, undefined, async () => result);
  for (const invalid of [
    { reply: "Incompleto", content: {} },
    {
      reply: "BNCC inventada",
      content: {
        ...f.content,
        questions: investigationQuestions,
        bnccReference: { code: "FALSO", sourceUrl: "https://example.com" },
      },
    },
    {
      reply: "Critérios duplicados",
      content: {
        ...f.content,
        questions: investigationQuestions,
        rubric: [f.content.rubric[0], f.content.rubric[0]],
      },
    },
    {
      reply: "Somente tela",
      content: {
        ...f.content,
        questions: investigationQuestions,
        steps: f.content.steps.map((s) => ({ ...s, mode: "screen" })),
      },
    },
  ]) {
    result = invalid;
    const response = await f.send(
      "POST",
      "/planning/assistant",
      f.maria.token,
      planningRequest(f.classroom.id),
    );
    assert.equal(response.statusCode, 502, response.body);
    assert.match(response.body, /AI_INVALID_RESPONSE/);
  }
});
test("assistente limita custo e impede pedidos simultâneos do mesmo professor", async (t) => {
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hold = true,
    calls = 0;
  const f = await fixture(t, undefined, async (context) => {
    calls++;
    if (hold) {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return {
      reply: "Proposta de teste",
      content: {
        ...planningTemplate({ ...context, theme: "teste" }),
        questions: investigationQuestions,
      },
    };
  });
  const body = planningRequest(f.classroom.id);
  const first = f
    .send("POST", "/planning/assistant", f.maria.token, body)
    .then((result) => result);
  await started;
  assert.equal(
    (await f.send("POST", "/planning/assistant", f.maria.token, body))
      .statusCode,
    429,
  );
  finish({
    reply: "Proposta de teste",
    content: { ...f.content, questions: investigationQuestions },
  });
  assert.equal((await first).statusCode, 200);
  hold = false;
  for (let i = 1; i < 12; i++)
    await f.ok("POST", "/planning/assistant", f.maria.token, body);
  const limited = await f.send(
    "POST",
    "/planning/assistant",
    f.maria.token,
    body,
  );
  assert.equal(limited.statusCode, 429);
  assert.match(limited.body, /AI_BUDGET_REACHED/);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(calls, 12);
});
test("investigação exige respostas exatas, preserva histórico e idempotência inclusive no registro mediado", async (t) => {
  const f = await fixture(t);
  const content = { ...f.content, questions: investigationQuestions };
  const bad = {
    ...content,
    questions: [investigationQuestions[0], investigationQuestions[0]],
  };
  assert.equal(
    (
      await f.send(
        "POST",
        "/classrooms/" + f.classroom.id + "/missions",
        f.maria.token,
        bad,
      )
    ).statusCode,
    422,
  );
  const mission = await f.ok(
    "POST",
    "/classrooms/" + f.classroom.id + "/missions",
    f.maria.token,
    content,
    201,
  );
  await f.ok("PATCH", "/missions/" + mission.id + "/status", f.maria.token, {
    baseVersion: 1,
    status: "published",
  });
  const answers = investigationQuestions.map((q) => ({
    questionId: q.id,
    text: "Uma resposta com cálculo e evidências.",
  }));
  const op = { ...f.operation(), missionId: mission.id, evidence: "", answers };
  for (const invalid of [
    undefined,
    [],
    answers.slice(0, 1),
    [answers[0], answers[0]],
    [...answers.slice(0, 1), { questionId: "inventada", text: "Teste" }],
  ]) {
    assert.equal(
      (
        await f.send("POST", "/sync/submissions", f.enzo.token, {
          ...op,
          answers: invalid,
        })
      ).statusCode,
      422,
    );
  }
  const sent = await f.ok("POST", "/sync/submissions", f.enzo.token, op);
  assert.deepEqual(sent.submission.answers, answers);
  const replay = await f.ok("POST", "/sync/submissions", f.enzo.token, {
    ...op,
    answers: [...answers].reverse(),
  });
  assert.equal(replay.replayed, true);
  assert.equal(
    (
      await f.send("POST", "/sync/submissions", f.enzo.token, {
        ...op,
        answers: answers.map((a) => ({ ...a, text: "Alterada" })),
      })
    ).statusCode,
    409,
  );
  const edited = {
    ...op,
    operationId: randomUUID(),
    baseVersion: 1,
    answers: answers.map((a) => ({ ...a, text: "Revisamos nossa evidência." })),
  };
  await f.ok("POST", "/sync/submissions", f.enzo.token, edited);
  const conflict = await f.send(
    "POST",
    "/sync/submissions",
    f.valentina.token,
    {
      ...op,
      operationId: randomUUID(),
      baseVersion: 1,
    },
  );
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(
    conflict.json().error.details.current.answers,
    edited.answers,
  );
  const history = await f.ok(
    "GET",
    "/submissions/" + op.submissionId + "/revisions",
    f.maria.token,
  );
  assert.deepEqual(history.items[0].content.answers, edited.answers);
  await f.ok("POST", "/sync/submissions", f.maria.token, {
    ...op,
    operationId: randomUUID(),
    submissionId: randomUUID(),
    groupId: f.otherGroup.id,
    channel: "teacher_mediated",
  });
});
test("assistente exige perguntas por tópico e preserva rascunhos antigos na entrada", async (t) => {
  let questions = investigationQuestions;
  const f = await fixture(t, undefined, async () => ({
    reply: "Proposta simulada",
    content: {
      ...planningTemplate({
        theme: "investigação",
        subject: "Matemática",
        schoolYear: "9º ano",
        durationMinutes: 30,
      }),
      questions,
    },
  }));
  const body = {
    ...planningRequest(f.classroom.id),
    currentDraft: f.content,
    topics: ["Porcentagem", "Comparação"],
  };
  await f.ok("POST", "/planning/assistant", f.maria.token, body);
  questions = investigationQuestions.slice(0, 1);
  assert.equal(
    (await f.send("POST", "/planning/assistant", f.maria.token, body))
      .statusCode,
    502,
  );
  questions = [investigationQuestions[0]!, investigationQuestions[0]!];
  assert.equal(
    (await f.send("POST", "/planning/assistant", f.maria.token, body))
      .statusCode,
    502,
  );
});
