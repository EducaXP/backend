import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { classroomAccess, groupAccess } from "../access.js";
import { hashPassword, teacher } from "../auth.js";
import type { Store } from "../db.js";
import { ApiError, type Classroom, type Group } from "../domain.js";
import { idParams, object, pagination, text, uuid } from "../schemas.js";
export function classroomRoutes(instance: FastifyInstance, db: Store) {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.post(
    "/classrooms",
    {
      preHandler: teacher,
      schema: { tags: ["Turmas"], body: object({ name: text(100) }) },
    },
    async (req, reply) => {
      const id = randomUUID();
      const joinCode = randomBytes(6).toString("hex").toUpperCase();
      await db.run(
        "INSERT INTO classrooms(id,school_id,teacher_id,name,join_code) VALUES($1,$2,$3,$4,$5)",
        id,
        req.user.school_id,
        req.user.id,
        req.body.name,
        joinCode,
      );
      return reply
        .code(201)
        .send({ id, name: req.body.name, joinCode, paused: false });
    },
  );
  app.get(
    "/classrooms",
    { schema: { tags: ["Turmas"], querystring: pagination } },
    async (req) => {
      const rows = await db.all<Classroom>(
        "SELECT c.* FROM classrooms c WHERE c.school_id=$1 AND\n      (c.teacher_id=$2 OR EXISTS(SELECT 1 FROM memberships m WHERE m.classroom_id=c.id AND m.user_id=$3))\n      ORDER BY c.id LIMIT $4 OFFSET $5",
        req.user.school_id,
        req.user.id,
        req.user.id,
        req.query.limit ?? 30,
        req.query.offset ?? 0,
      );
      return {
        items: rows.map((c) => ({
          id: c.id,
          name: c.name,
          paused: !!c.paused,
          ...(req.user.role === "teacher" ? { joinCode: c.join_code } : {}),
        })),
      };
    },
  );
  app.post(
    "/classrooms/:id/students",
    {
      preHandler: teacher,
      schema: {
        tags: ["Turmas"],
        params: idParams,
        body: object({
          name: text(80),
          alias: Type.String({ pattern: "^[a-z0-9_-]{2,24}$" }),
        }),
      },
    },
    async (req, reply) => {
      const classroom = await classroomAccess(db, req.user, req.params.id);
      if (
        await db.get(
          "SELECT 1 FROM memberships WHERE classroom_id=$1 AND alias=$2",
          classroom.id,
          req.body.alias,
        )
      ) {
        throw new ApiError(
          409,
          "ALIAS_TAKEN",
          "Este apelido já está em uso na turma.",
        );
      }
      const id = randomUUID();
      const pin = String(randomInt(100000, 1000000));
      const hash = await hashPassword(pin);
      // Check again within the transaction to handle concurrent registrations.
      await db.transaction(async () => {
        if (
          await db.get(
            "SELECT 1 FROM memberships WHERE classroom_id=$1 AND alias=$2",
            classroom.id,
            req.body.alias,
          )
        ) {
          throw new ApiError(
            409,
            "ALIAS_TAKEN",
            "Este apelido já está em uso na turma.",
          );
        }
        await db.run(
          "INSERT INTO users(id,school_id,role,name,login,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
          id,
          classroom.school_id,
          "student",
          req.body.name,
          `student-${id}`,
          hash,
        );
        await db.run(
          "INSERT INTO memberships(classroom_id,user_id,alias) VALUES($1,$2,$3)",
          classroom.id,
          id,
          req.body.alias,
        );
      });
      return reply.code(201).send({
        id,
        name: req.body.name,
        alias: req.body.alias,
        pin,
        notice:
          "PIN exibido apenas nesta resposta. Entregue individualmente ao estudante.",
      });
    },
  );
  app.get(
    "/classrooms/:id/students",
    {
      preHandler: teacher,
      schema: { tags: ["Turmas"], params: idParams, querystring: pagination },
    },
    async (req) => {
      await classroomAccess(db, req.user, req.params.id);
      return {
        items: await db.all(
          "SELECT u.id,u.name,m.alias FROM memberships m JOIN users u ON u.id=m.user_id\n      WHERE m.classroom_id=$1 ORDER BY m.alias LIMIT $2 OFFSET $3",
          req.params.id,
          req.query.limit ?? 30,
          req.query.offset ?? 0,
        ),
      };
    },
  );
  app.post(
    "/classrooms/:id/students/:studentId/reset-pin",
    {
      preHandler: teacher,
      schema: {
        tags: ["Turmas"],
        params: object({ id: uuid, studentId: uuid }),
      },
    },
    async (req) => {
      await classroomAccess(db, req.user, req.params.id);
      if (
        !(await db.get(
          "SELECT 1 FROM memberships WHERE classroom_id=$1 AND user_id=$2",
          req.params.id,
          req.params.studentId,
        ))
      ) {
        throw new ApiError(404, "NOT_FOUND", "Estudante não encontrado.");
      }
      const pin = String(randomInt(100000, 1000000));
      const hash = await hashPassword(pin);
      await db.transaction(async () => {
        await db.run(
          "UPDATE users SET password_hash=$1 WHERE id=$2",
          hash,
          req.params.studentId,
        );
        await db.run(
          "DELETE FROM sessions WHERE user_id=$1",
          req.params.studentId,
        );
      });
      return {
        pin,
        notice:
          "As sessões anteriores foram encerradas. Entregue o novo PIN individualmente.",
      };
    },
  );
  app.post(
    "/classrooms/:id/groups",
    {
      preHandler: teacher,
      schema: {
        tags: ["Grupos"],
        params: idParams,
        body: object({
          name: text(80),
          members: Type.Array(object({ studentId: uuid, role: text(80) }), {
            minItems: 1,
            maxItems: 12,
          }),
        }),
      },
    },
    async (req, reply) => {
      await classroomAccess(db, req.user, req.params.id);
      const id = randomUUID();
      await db.transaction(async () => {
        const ids = new Set(req.body.members.map((member) => member.studentId));
        if (ids.size !== req.body.members.length)
          throw new ApiError(
            422,
            "DUPLICATE_MEMBER",
            "Cada estudante deve aparecer apenas uma vez.",
          );
        for (const studentId of ids) {
          if (
            !(await db.get(
              "SELECT 1 FROM memberships WHERE classroom_id=$1 AND user_id=$2",
              req.params.id,
              studentId,
            ))
          ) {
            throw new ApiError(
              422,
              "INVALID_MEMBER",
              "Todos os integrantes devem pertencer à turma.",
            );
          }
          if (
            await db.get(
              "SELECT 1 FROM group_members WHERE classroom_id=$1 AND user_id=$2",
              req.params.id,
              studentId,
            )
          ) {
            throw new ApiError(
              409,
              "ALREADY_GROUPED",
              "Um integrante já pertence a um grupo nesta turma.",
            );
          }
        }
        await db.run(
          "INSERT INTO groups(id,classroom_id,name) VALUES($1,$2,$3)",
          id,
          req.params.id,
          req.body.name,
        );
        for (const member of req.body.members)
          await db.run(
            "INSERT INTO group_members(group_id,classroom_id,user_id,role) VALUES($1,$2,$3,$4)",
            id,
            req.params.id,
            member.studentId,
            member.role,
          );
      });
      return reply
        .code(201)
        .send({ id, classroomId: req.params.id, ...req.body });
    },
  );
  app.get(
    "/classrooms/:id/groups",
    {
      schema: { tags: ["Grupos"], params: idParams, querystring: pagination },
    },
    async (req) => {
      await classroomAccess(db, req.user, req.params.id);
      const groups = await db.all<Group>(
        "SELECT g.* FROM groups g WHERE g.classroom_id=$1 AND\n      ($2='teacher' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=$3))\n      ORDER BY g.id LIMIT $4 OFFSET $5",
        req.params.id,
        req.user.role,
        req.user.id,
        req.query.limit ?? 30,
        req.query.offset ?? 0,
      );
      return {
        items: await Promise.all(
          groups.map(async (g) => ({
            id: g.id,
            classroomId: g.classroom_id,
            name: g.name,
            members: await db.all(
              "SELECT u.id,u.name,gm.role FROM group_members gm JOIN users u ON u.id=gm.user_id\n        WHERE gm.group_id=$1 ORDER BY u.id",
              g.id,
            ),
          })),
        ),
      };
    },
  );
  app.put(
    "/groups/:id/roles",
    {
      preHandler: teacher,
      schema: {
        tags: ["Grupos"],
        params: idParams,
        body: object({
          members: Type.Array(object({ studentId: uuid, role: text(80) }), {
            minItems: 1,
            maxItems: 12,
          }),
        }),
      },
    },
    async (req) =>
      await db.transaction(async () => {
        await groupAccess(db, req.user, req.params.id);
        const current = await db.all<{
          user_id: string;
        }>(
          "SELECT user_id FROM group_members WHERE group_id=$1",
          req.params.id,
        );
        const incoming = new Set(req.body.members.map((m) => m.studentId));
        if (
          incoming.size !== req.body.members.length ||
          incoming.size !== current.length ||
          current.some((m) => !incoming.has(m.user_id))
        ) {
          throw new ApiError(
            422,
            "INVALID_MEMBERS",
            "A rotação deve manter os mesmos integrantes do grupo.",
          );
        }
        for (const member of req.body.members)
          await db.run(
            "UPDATE group_members SET role=$1 WHERE group_id=$2 AND user_id=$3",
            member.role,
            req.params.id,
            member.studentId,
          );
        return { id: req.params.id, members: req.body.members };
      }),
  );
  app.patch(
    "/classrooms/:id/pause",
    {
      preHandler: teacher,
      schema: {
        tags: ["Turmas"],
        params: idParams,
        body: object({ paused: Type.Boolean() }),
      },
    },
    async (req) => {
      await classroomAccess(db, req.user, req.params.id);
      await db.run(
        "UPDATE classrooms SET paused=$1 WHERE id=$2",
        Number(req.body.paused),
        req.params.id,
      );
      return {
        paused: req.body.paused,
        message:
          "Combinado de pausa atualizado. Entregas pendentes continuam sendo recebidas.",
      };
    },
  );
  app.get(
    "/classrooms/:id/dashboard",
    {
      preHandler: teacher,
      schema: { tags: ["Painel docente"], params: idParams },
    },
    async (req) => {
      const classroom = await classroomAccess(db, req.user, req.params.id);
      const count = async (sql: string) =>
        (await db.get<{
          n: number;
        }>(sql, classroom.id))!.n;
      return {
        classroomId: classroom.id,
        paused: !!classroom.paused,
        enrolledStudents: await count(
          "SELECT count(*) n FROM memberships WHERE classroom_id=$1",
        ),
        groups: await count(
          "SELECT count(*) n FROM groups WHERE classroom_id=$1",
        ),
        publishedMissions: await count(
          "SELECT count(*) n FROM missions WHERE classroom_id=$1 AND status='published'",
        ),
        submissions: await count(
          "SELECT count(*) n FROM submissions s JOIN missions m ON m.id=s.mission_id WHERE m.classroom_id=$1",
        ),
        awaitingReview: await count(
          "SELECT count(*) n FROM submissions s JOIN missions m ON m.id=s.mission_id\n        WHERE m.classroom_id=$1 AND NOT EXISTS(SELECT 1 FROM evaluations e WHERE e.submission_id=s.id AND e.submission_version=s.version)",
        ),
        openHelpRequests: await count(
          "SELECT count(*) n FROM help_requests h JOIN groups g ON g.id=h.group_id\n        WHERE g.classroom_id=$1 AND h.resolved_at IS NULL",
        ),
        updatedAt: new Date().toISOString(),
      };
    },
  );
}
