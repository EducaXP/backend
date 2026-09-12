import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { classroomAccess, missionAccess } from "../access.js";
import { teacher } from "../auth.js";
import type { Store } from "../db.js";
import { ApiError, now, type MissionRow } from "../domain.js";
import { planningTemplate } from "../planning.js";
import {
  idParams,
  missionContent,
  missionEdit,
  object,
  pagination,
  text,
  version,
  type MissionContent,
} from "../schemas.js";
export const missionView = (row: MissionRow) => ({
  id: row.id,
  classroomId: row.classroom_id,
  status: row.status,
  version: row.version,
  content: JSON.parse(row.content),
  bnccVerification: "pending",
  createdAt: row.created_at,
});
function validateRubric(content: MissionContent) {
  if (
    content.questions &&
    new Set(content.questions.map((q) => q.id)).size !==
      content.questions.length
  )
    throw new ApiError(
      422,
      "DUPLICATE_QUESTION",
      "Cada questão precisa de um identificador diferente.",
    );
  if (new Set(content.rubric.map((c) => c.id)).size !== content.rubric.length) {
    throw new ApiError(
      422,
      "DUPLICATE_CRITERION",
      "Cada critério da rubrica deve ter um identificador diferente.",
    );
  }
}
export function missionRoutes(instance: FastifyInstance, db: Store) {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.post(
    "/classrooms/:id/missions",
    {
      preHandler: teacher,
      schema: { tags: ["Missões"], params: idParams, body: missionContent },
    },
    async (req, reply) => {
      await classroomAccess(db, req.user, req.params.id);
      validateRubric(req.body);
      const id = randomUUID();
      await db.run(
        "INSERT INTO missions(id,classroom_id,content,created_at) VALUES($1,$2,$3,$4)",
        id,
        req.params.id,
        JSON.stringify(req.body),
        now(),
      );
      return reply
        .code(201)
        .send(
          missionView(
            (await db.get<MissionRow>(
              "SELECT * FROM missions WHERE id=$1",
              id,
            ))!,
          ),
        );
    },
  );
  app.get(
    "/classrooms/:id/missions",
    {
      schema: { tags: ["Missões"], params: idParams, querystring: pagination },
    },
    async (req) => {
      await classroomAccess(db, req.user, req.params.id);
      const rows = await db.all<MissionRow>(
        "SELECT * FROM missions WHERE classroom_id=$1 AND ($2='teacher' OR status!='draft')\n      ORDER BY created_at,id LIMIT $3 OFFSET $4",
        req.params.id,
        req.user.role,
        req.query.limit ?? 30,
        req.query.offset ?? 0,
      );
      return { items: rows.map(missionView) };
    },
  );
  app.get(
    "/missions/:id",
    { schema: { tags: ["Missões"], params: idParams } },
    async (req) =>
      missionView(await missionAccess(db, req.user, req.params.id)),
  );
  app.put(
    "/missions/:id",
    {
      preHandler: teacher,
      schema: { tags: ["Missões"], params: idParams, body: missionEdit },
    },
    async (req) =>
      await db.transaction(async () => {
        const mission = await missionAccess(db, req.user, req.params.id);
        if (mission.version !== req.body.baseVersion)
          throw new ApiError(
            409,
            "VERSION_CONFLICT",
            "O rascunho mudou. Recarregue antes de editar.",
            { current: missionView(mission) },
          );
        if (mission.status !== "draft")
          throw new ApiError(
            409,
            "MISSION_LOCKED",
            "O conteúdo publicado é preservado para manter as entregas e rubricas consistentes. Crie outra missão.",
          );
        validateRubric(req.body.content);
        await db.run(
          "UPDATE missions SET content=$1,version=version+1 WHERE id=$2",
          JSON.stringify(req.body.content),
          mission.id,
        );
        return missionView(
          (await db.get<MissionRow>(
            "SELECT * FROM missions WHERE id=$1",
            mission.id,
          ))!,
        );
      }),
  );
  app.patch(
    "/missions/:id/status",
    {
      preHandler: teacher,
      schema: {
        tags: ["Missões"],
        params: idParams,
        body: object({
          baseVersion: version,
          status: Type.Union([
            Type.Literal("published"),
            Type.Literal("closed"),
          ]),
        }),
      },
    },
    async (req) =>
      await db.transaction(async () => {
        const mission = await missionAccess(db, req.user, req.params.id);
        if (mission.version !== req.body.baseVersion)
          throw new ApiError(
            409,
            "VERSION_CONFLICT",
            "O estado da missão mudou.",
            { current: missionView(mission) },
          );
        const valid =
          (mission.status === "draft" && req.body.status === "published") ||
          (mission.status === "published" && req.body.status === "closed");
        if (!valid)
          throw new ApiError(
            409,
            "INVALID_TRANSITION",
            "Transição de estado inválida.",
          );
        await db.run(
          "UPDATE missions SET status=$1,version=version+1 WHERE id=$2",
          req.body.status,
          mission.id,
        );
        return missionView(
          (await db.get<MissionRow>(
            "SELECT * FROM missions WHERE id=$1",
            mission.id,
          ))!,
        );
      }),
  );
  app.post(
    "/planning/drafts",
    {
      preHandler: teacher,
      schema: {
        tags: ["Planejamento"],
        summary:
          "Gera modelo editável local, sem IA generativa nem validação BNCC",
        body: object({
          theme: text(100),
          subject: text(100),
          schoolYear: text(50),
          durationMinutes: Type.Integer({ minimum: 1, maximum: 240 }),
        }),
      },
    },
    async (req) => ({
      mode: "local_template",
      requiresTeacherReview: true,
      bnccVerification: "pending",
      notice:
        "Modelo determinístico editável. Não utiliza IA generativa nem verifica alinhamento à BNCC.",
      content: planningTemplate(req.body),
    }),
  );
}
