import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { classroomAccess, groupAccess, missionAccess } from "../access.js";
import { digest } from "../auth.js";
import type { Store } from "../db.js";
import { ApiError, now } from "../domain.js";
import { object, text, uuid, idParams, pagination } from "../schemas.js";
const input = object({
  operationId: uuid,
  missionId: uuid,
  groupId: uuid,
  goal: text(300),
  strategy: text(300),
  reflection: text(1500),
  channel: Type.Union([
    Type.Literal("digital"),
    Type.Literal("teacher_mediated"),
  ]),
});
export function focusRoutes(instance: FastifyInstance, db: Store) {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.get(
    "/classrooms/:id/focus",
    { schema: { params: idParams, querystring: pagination } },
    async (req) => {
      await classroomAccess(db, req.user, req.params.id);
      return {
        items: await db.all(
          `SELECT f.mission_id AS "missionId",f.group_id AS "groupId",f.goal,f.strategy,f.reflection,f.channel FROM focus_records f JOIN groups g ON g.id=f.group_id WHERE g.classroom_id=$1 AND ($2='teacher' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=$3)) ORDER BY f.mission_id,f.group_id LIMIT $4 OFFSET $5`,
          req.params.id,
          req.user.role,
          req.user.id,
          req.query.limit ?? 30,
          req.query.offset ?? 0,
        ),
      };
    },
  );
  app.post("/sync/focus", { schema: { body: input } }, async (req) =>
    db.transaction(async () => {
      const b = req.body;
      const group = await groupAccess(db, req.user, b.groupId);
      const mission = await missionAccess(db, req.user, b.missionId);
      if (group.classroom_id !== mission.classroom_id)
        throw new ApiError(
          422,
          "CLASSROOM_MISMATCH",
          "Grupo e missão devem pertencer à mesma turma.",
        );
      if (mission.status === "draft")
        throw new ApiError(
          409,
          "MISSION_NOT_PUBLISHED",
          "Publique a missão antes de registrar o combinado.",
        );
      if (req.user.role !== "teacher" && b.channel === "teacher_mediated")
        throw new ApiError(
          403,
          "FORBIDDEN",
          "O registro mediado deve ser feito pelo educador.",
        );
      const content = {
        missionId: b.missionId,
        groupId: b.groupId,
        goal: b.goal.trim(),
        strategy: b.strategy.trim(),
        reflection: b.reflection.trim(),
        channel: b.channel,
      };
      const fingerprint = digest(JSON.stringify({ kind: "focus", ...content }));
      const previous = await db.get<{ fingerprint: string; response: string }>(
        "SELECT fingerprint,response FROM operations WHERE user_id=$1 AND operation_id=$2",
        req.user.id,
        b.operationId,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Esta operação já foi usada para outro conteúdo.",
          );
        return { ...JSON.parse(previous.response), replayed: true };
      }
      if (
        await db.get(
          "SELECT 1 FROM focus_records WHERE mission_id=$1 AND group_id=$2",
          b.missionId,
          b.groupId,
        )
      )
        throw new ApiError(
          409,
          "FOCUS_ALREADY_RECORDED",
          "A equipe já registrou o combinado nesta missão. Seu texto local foi preservado.",
        );
      const timestamp = now();
      await db.run(
        "INSERT INTO focus_records VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        b.missionId,
        b.groupId,
        req.user.id,
        content.goal,
        content.strategy,
        content.reflection,
        b.channel,
        timestamp,
      );
      const awarded = await db.run(
        "INSERT INTO focus_rewards(user_id,mission_id,xp,created_at) SELECT user_id,$1,25,$2 FROM group_members WHERE group_id=$3 ON CONFLICT DO NOTHING",
        b.missionId,
        timestamp,
        b.groupId,
      );
      const result = {
        record: content,
        awardedStudents: awarded.changes,
        xpPerStudent: 25,
      };
      await db.run(
        "INSERT INTO operations VALUES($1,$2,$3,$4,$5)",
        req.user.id,
        b.operationId,
        fingerprint,
        JSON.stringify(result),
        timestamp,
      );
      return { ...result, replayed: false };
    }),
  );
}
