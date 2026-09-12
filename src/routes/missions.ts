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
      classroomAccess(db, req.user, req.params.id);
      validateRubric(req.body);
      const id = randomUUID();
      db.run(
        "INSERT INTO missions(id,classroom_id,content,created_at) VALUES(?,?,?,?)",
        id,
        req.params.id,
        JSON.stringify(req.body),
        now(),
      );
      return reply
        .code(201)
        .send(
          missionView(
            db.get<MissionRow>("SELECT * FROM missions WHERE id=?", id)!,
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
      classroomAccess(db, req.user, req.params.id);
      const rows = db.all<MissionRow>(
        `SELECT * FROM missions WHERE classroom_id=? AND (?='teacher' OR status!='draft')
      ORDER BY created_at,id LIMIT ? OFFSET ?`,
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
    async (req) => missionView(missionAccess(db, req.user, req.params.id)),
  );
  app.put(
    "/missions/:id",
    {
      preHandler: teacher,
      schema: { tags: ["Missões"], params: idParams, body: missionEdit },
    },
    async (req) =>
      db.transaction(() => {
        const mission = missionAccess(db, req.user, req.params.id);
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
        db.run(
          "UPDATE missions SET content=?,version=version+1 WHERE id=?",
          JSON.stringify(req.body.content),
          mission.id,
        );
        return missionView(
          db.get<MissionRow>("SELECT * FROM missions WHERE id=?", mission.id)!,
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
      db.transaction(() => {
        const mission = missionAccess(db, req.user, req.params.id);
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
        db.run(
          "UPDATE missions SET status=?,version=version+1 WHERE id=?",
          req.body.status,
          mission.id,
        );
        return missionView(
          db.get<MissionRow>("SELECT * FROM missions WHERE id=?", mission.id)!,
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
