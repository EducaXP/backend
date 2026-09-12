import { randomBytes, randomUUID } from "node:crypto";
import { buildApp } from "./app.js";
import { hashPassword, issueSession } from "./auth.js";
import { loadConfig } from "./config.js";
import { planningTemplate } from "./planning.js";
const config = loadConfig();
if (process.env.NODE_ENV === "production")
  throw new Error("O seed fictício não deve ser executado em produção.");
const { app, db } = await buildApp(config);
try {
  if (await db.get("SELECT 1 FROM users LIMIT 1")) {
    console.log(
      "Banco já contém usuários. Nenhum dado ou credencial foi alterado.",
    );
  } else {
    const teacherId = randomUUID();
    const schoolId = randomUUID();
    const password = randomBytes(18).toString("base64url");
    const hash = await hashPassword(password);
    await db.transaction(async () => {
      await db.run(
        "INSERT INTO schools(id,name) VALUES($1,$2)",
        schoolId,
        "Escola Demonstração EducaXP",
      );
      await db.run(
        "INSERT INTO users(id,school_id,role,name,login,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
        teacherId,
        schoolId,
        "teacher",
        "Prof.ª Maria (fictícia)",
        "demo.maria",
        hash,
      );
    });
    const { token } = await issueSession(db, teacherId, 1);
    const headers = { authorization: `Bearer ${token}` };
    const post = async (path: string, payload: object) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1${path}`,
        headers,
        payload,
      });
      if (response.statusCode >= 400)
        throw new Error(`Falha no seed: ${path} (${response.statusCode})`);
      return response.json();
    };
    const classroom = await post("/classrooms", {
      name: "9º ano A • Demonstração",
    });
    const enzo = await post(`/classrooms/${classroom.id}/students`, {
      name: "Enzo (fictício)",
      alias: "enzo",
    });
    const valentina = await post(`/classrooms/${classroom.id}/students`, {
      name: "Valentina (fictícia)",
      alias: "valentina",
    });
    await post(`/classrooms/${classroom.id}/groups`, {
      name: "Equipe Ipê",
      members: [
        { studentId: enzo.id, role: "Investigação" },
        { studentId: valentina.id, role: "Registro e apresentação" },
      ],
    });
    const mission = await post(
      `/classrooms/${classroom.id}/missions`,
      planningTemplate({
        theme: "consumo de água na escola",
        subject: "Matemática",
        schoolYear: "9º ano",
        durationMinutes: 30,
      }),
    );
    const published = await app.inject({
      method: "PATCH",
      url: `/api/v1/missions/${mission.id}/status`,
      headers,
      payload: { baseVersion: 1, status: "published" },
    });
    if (published.statusCode !== 200)
      throw new Error("Falha ao publicar a missão de demonstração.");
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers });
    console.log(
      "Demonstração criada com dados fictícios. Guarde estas credenciais; não são gravadas em texto no banco.",
    );
    console.log(
      JSON.stringify(
        {
          teacher: { login: "demo.maria", password },
          classroom: { id: classroom.id, classCode: classroom.joinCode },
          students: [
            { alias: "enzo", pin: enzo.pin },
            { alias: "valentina", pin: valentina.pin },
          ],
          missionId: mission.id,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await app.close();
}
