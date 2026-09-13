import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  classroomAccess,
  groupAccess,
  missionAccess,
  submissionAccess,
} from "../access.js";
import { student, teacher } from "../auth.js";
import type { Store } from "../db.js";
import {
  ApiError,
  catalog,
  now,
  requireFound,
  type EvaluationRow,
  type SubmissionRow,
} from "../domain.js";
import {
  avatarWrite,
  evaluationWrite,
  idParams,
  object,
  pagination,
  submissionWrite,
  text,
  type MissionContent,
} from "../schemas.js";
import { submissionView, writeSubmission } from "../submissions.js";
const evaluationView = (row: EvaluationRow) => ({
  id: row.id,
  submissionId: row.submission_id,
  submissionVersion: row.submission_version,
  feedback: row.feedback,
  scores: JSON.parse(row.scores),
  createdAt: row.created_at,
});
export function learningRoutes(instance: FastifyInstance, db: Store) {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.post(
    "/sync/submissions",
    {
      schema: {
        tags: ["Sincronização"],
        body: submissionWrite,
        summary: "Envia uma operação idempotente com controle de versão",
      },
    },
    async (req) => await writeSubmission(db, req.user, req.body),
  );
  app.get(
    "/submissions/:id",
    { schema: { tags: ["Entregas"], params: idParams } },
    async (req) => {
      const submission = await submissionAccess(db, req.user, req.params.id);
      const evaluation = await db.get<EvaluationRow>(
        "SELECT * FROM evaluations WHERE submission_id=$1 AND submission_version=$2",
        submission.id,
        submission.version,
      );
      return {
        ...submissionView(submission),
        evaluation: evaluation ? evaluationView(evaluation) : null,
      };
    },
  );
  app.get(
    "/missions/:id/submissions",
    {
      schema: { tags: ["Entregas"], params: idParams, querystring: pagination },
    },
    async (req) => {
      await missionAccess(db, req.user, req.params.id);
      return {
        items: (
          await db.all<SubmissionRow>(
            "SELECT s.* FROM submissions s WHERE s.mission_id=$1 AND\n      ($2='teacher' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=s.group_id AND gm.user_id=$3))\n      ORDER BY s.updated_at,s.id LIMIT $4 OFFSET $5",
            req.params.id,
            req.user.role,
            req.user.id,
            req.query.limit ?? 30,
            req.query.offset ?? 0,
          )
        ).map(submissionView),
      };
    },
  );
  app.get(
    "/submissions/:id/revisions",
    {
      schema: { tags: ["Entregas"], params: idParams, querystring: pagination },
    },
    async (req) => {
      await submissionAccess(db, req.user, req.params.id);
      return {
        items: (
          await db.all<{
            version: number;
            content: string;
            created_at: string;
          }>(
            "SELECT version,content,created_at FROM submission_revisions WHERE submission_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3",
            req.params.id,
            req.query.limit ?? 30,
            req.query.offset ?? 0,
          )
        ).map((row) => ({
          version: row.version,
          content: JSON.parse(row.content),
          createdAt: row.created_at,
        })),
      };
    },
  );
  app.post(
    "/submissions/:id/evaluations",
    {
      preHandler: teacher,
      schema: { tags: ["Avaliações"], params: idParams, body: evaluationWrite },
    },
    async (req) =>
      await db.transaction(async () => {
        const submission = await submissionAccess(db, req.user, req.params.id);
        if (submission.version !== req.body.submissionVersion) {
          throw new ApiError(
            409,
            "VERSION_CONFLICT",
            "A entrega foi atualizada. Revise a versão atual antes de avaliar.",
            { currentVersion: submission.version },
          );
        }
        const mission = await missionAccess(
          db,
          req.user,
          submission.mission_id,
        );
        const content: MissionContent = JSON.parse(mission.content);
        const scores = [...req.body.scores].sort((a, b) =>
          a.criterionId.localeCompare(b.criterionId),
        );
        if (
          scores.length !== content.rubric.length ||
          new Set(scores.map((s) => s.criterionId)).size !== scores.length ||
          scores.some(
            (score) => !content.rubric.some((c) => c.id === score.criterionId),
          )
        ) {
          throw new ApiError(
            422,
            "INVALID_RUBRIC",
            "Informe uma avaliação para cada critério da rubrica publicada.",
          );
        }
        const serializedScores = JSON.stringify(scores);
        const previous = await db.get<EvaluationRow>(
          "SELECT * FROM evaluations WHERE submission_id=$1 AND submission_version=$2",
          submission.id,
          submission.version,
        );
        if (previous) {
          // Published evaluations are immutable in this first version.
          throw new ApiError(
            409,
            "ALREADY_EVALUATED",
            "Esta versão já foi avaliada.",
            { evaluation: evaluationView(previous) },
          );
        }
        const id = randomUUID();
        const timestamp = now();
        await db.run(
          "INSERT INTO evaluations(id,submission_id,submission_version,teacher_id,feedback,scores,created_at)\n      VALUES($1,$2,$3,$4,$5,$6,$7)",
          id,
          submission.id,
          submission.version,
          req.user.id,
          req.body.feedback,
          serializedScores,
          timestamp,
        );
        let awardedStudents = 0;
        if (req.body.recognizeParticipation) {
          const result = await db.run(
            "INSERT INTO rewards(user_id,mission_id,xp,reason,created_at)\n        SELECT user_id,$1,100,'Participa\u00E7\u00E3o reconhecida pelo educador',$2 FROM group_members WHERE group_id=$3 ON CONFLICT DO NOTHING",
            mission.id,
            timestamp,
            submission.group_id,
          );
          awardedStudents = Number(result.changes);
        }
        return {
          evaluation: evaluationView(
            (await db.get<EvaluationRow>(
              "SELECT * FROM evaluations WHERE id=$1",
              id,
            ))!,
          ),
          awardedStudents,
        };
      }),
  );
  app.post(
    "/groups/:id/help",
    {
      preHandler: student,
      schema: {
        tags: ["Ajuda"],
        params: idParams,
        body: object({ message: text(1000) }),
      },
    },
    async (req, reply) => {
      await groupAccess(db, req.user, req.params.id);
      const id = randomUUID();
      const timestamp = now();
      await db.run(
        "INSERT INTO help_requests(id,group_id,message,created_at) VALUES($1,$2,$3,$4)",
        id,
        req.params.id,
        req.body.message,
        timestamp,
      );
      return reply.code(201).send({
        id,
        message: req.body.message,
        createdAt: timestamp,
        resolvedAt: null,
      });
    },
  );
  app.get(
    "/classrooms/:id/help",
    { schema: { tags: ["Ajuda"], params: idParams, querystring: pagination } },
    async (req) => {
      await classroomAccess(db, req.user, req.params.id);
      return {
        items: await db.all(
          'SELECT h.id,h.group_id AS "groupId",h.message,h.answer,h.created_at AS "createdAt",h.resolved_at AS "resolvedAt"\n      FROM help_requests h JOIN groups g ON g.id=h.group_id WHERE g.classroom_id=$1 AND\n      ($2=\'teacher\' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=$3))\n      ORDER BY h.created_at DESC,h.id LIMIT $4 OFFSET $5',
          req.params.id,
          req.user.role,
          req.user.id,
          req.query.limit ?? 30,
          req.query.offset ?? 0,
        ),
      };
    },
  );
  app.patch(
    "/help/:id/resolve",
    {
      preHandler: teacher,
      schema: {
        tags: ["Ajuda"],
        params: idParams,
        body: object({ answer: text(2000) }),
      },
    },
    async (req) => {
      const help = requireFound(
        await db.get<{
          group_id: string;
          resolved_at: string | null;
        }>(
          "SELECT group_id,resolved_at FROM help_requests WHERE id=$1",
          req.params.id,
        ),
      );
      await groupAccess(db, req.user, help.group_id);
      if (help.resolved_at)
        throw new ApiError(
          409,
          "ALREADY_RESOLVED",
          "Este pedido já foi respondido.",
        );
      const timestamp = now();
      await db.run(
        "UPDATE help_requests SET answer=$1,resolved_at=$2 WHERE id=$3",
        req.body.answer,
        timestamp,
        req.params.id,
      );
      return {
        id: req.params.id,
        answer: req.body.answer,
        resolvedAt: timestamp,
      };
    },
  );
  app.get(
    "/me/avatar",
    { preHandler: student, schema: { tags: ["Avatar"] } },
    async (req) => {
      const xp = (await db.get<{
        xp: number;
      }>(
        "SELECT coalesce(sum(xp),0) xp FROM (SELECT xp FROM rewards WHERE user_id=$1 UNION ALL SELECT xp FROM focus_rewards WHERE user_id=$1) total",
        req.user.id,
      ))!.xp;
      return {
        itemId: req.user.avatar_item,
        ecoMode: !!req.user.eco_mode,
        xp,
        catalog: catalog.map((item) => ({
          ...item,
          unlocked: xp >= item.requiredXp,
        })),
        rewardRule:
          "100 XP pela participação reconhecida pelo professor e 25 XP pelo combinado e reflexão de foco da equipe, uma vez por missão. Papel e registro mediado também valem.",
      };
    },
  );
  app.put(
    "/me/avatar",
    { preHandler: student, schema: { tags: ["Avatar"], body: avatarWrite } },
    async (req) => {
      const item = catalog.find((c) => c.id === req.body.itemId);
      if (!item)
        throw new ApiError(422, "INVALID_ITEM", "Item de avatar inexistente.");
      const xp = (await db.get<{
        xp: number;
      }>(
        "SELECT coalesce(sum(xp),0) xp FROM (SELECT xp FROM rewards WHERE user_id=$1 UNION ALL SELECT xp FROM focus_rewards WHERE user_id=$1) total",
        req.user.id,
      ))!.xp;
      if (xp < item.requiredXp)
        throw new ApiError(
          409,
          "ITEM_LOCKED",
          "Este item ainda não foi desbloqueado.",
        );
      await db.run(
        "UPDATE users SET avatar_item=$1,eco_mode=$2 WHERE id=$3",
        item.id,
        Number(req.body.ecoMode),
        req.user.id,
      );
      return { itemId: item.id, ecoMode: req.body.ecoMode };
    },
  );
}
