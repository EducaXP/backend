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
      db.run(
        "INSERT INTO classrooms(id,school_id,teacher_id,name,join_code) VALUES(?,?,?,?,?)",
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
      const rows = db.all<Classroom>(
        `SELECT c.* FROM classrooms c WHERE c.school_id=? AND
      (c.teacher_id=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.classroom_id=c.id AND m.user_id=?))
      ORDER BY c.id LIMIT ? OFFSET ?`,
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
      const classroom = classroomAccess(db, req.user, req.params.id);
      if (
        db.get(
          "SELECT 1 FROM memberships WHERE classroom_id=? AND alias=?",
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
      db.transaction(() => {
        if (
          db.get(
            "SELECT 1 FROM memberships WHERE classroom_id=? AND alias=?",
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
        db.run(
          "INSERT INTO users(id,school_id,role,name,login,password_hash) VALUES(?,?,?,?,?,?)",
          id,
          classroom.school_id,
          "student",
          req.body.name,
          `student-${id}`,
          hash,
        );
        db.run(
          "INSERT INTO memberships(classroom_id,user_id,alias) VALUES(?,?,?)",
          classroom.id,
          id,
          req.body.alias,
        );
      });
      return reply
        .code(201)
        .send({
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
      classroomAccess(db, req.user, req.params.id);
      return {
        items: db.all(
          `SELECT u.id,u.name,m.alias FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.classroom_id=? ORDER BY m.alias LIMIT ? OFFSET ?`,
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
      classroomAccess(db, req.user, req.params.id);
      if (
        !db.get(
          "SELECT 1 FROM memberships WHERE classroom_id=? AND user_id=?",
          req.params.id,
          req.params.studentId,
        )
      ) {
        throw new ApiError(404, "NOT_FOUND", "Estudante não encontrado.");
      }
      const pin = String(randomInt(100000, 1000000));
      const hash = await hashPassword(pin);
      db.transaction(() => {
        db.run(
          "UPDATE users SET password_hash=? WHERE id=?",
          hash,
          req.params.studentId,
        );
        db.run("DELETE FROM sessions WHERE user_id=?", req.params.studentId);
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
      classroomAccess(db, req.user, req.params.id);
      const id = randomUUID();
      db.transaction(() => {
        const ids = new Set(req.body.members.map((member) => member.studentId));
        if (ids.size !== req.body.members.length)
          throw new ApiError(
            422,
            "DUPLICATE_MEMBER",
            "Cada estudante deve aparecer apenas uma vez.",
          );
        for (const studentId of ids) {
          if (
            !db.get(
              "SELECT 1 FROM memberships WHERE classroom_id=? AND user_id=?",
              req.params.id,
              studentId,
            )
          ) {
            throw new ApiError(
              422,
              "INVALID_MEMBER",
              "Todos os integrantes devem pertencer à turma.",
            );
          }
          if (
            db.get(
              "SELECT 1 FROM group_members WHERE classroom_id=? AND user_id=?",
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
        db.run(
          "INSERT INTO groups(id,classroom_id,name) VALUES(?,?,?)",
          id,
          req.params.id,
          req.body.name,
        );
        for (const member of req.body.members)
          db.run(
            "INSERT INTO group_members(group_id,classroom_id,user_id,role) VALUES(?,?,?,?)",
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
      classroomAccess(db, req.user, req.params.id);
      const groups = db.all<Group>(
        `SELECT g.* FROM groups g WHERE g.classroom_id=? AND
      (?='teacher' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?))
      ORDER BY g.id LIMIT ? OFFSET ?`,
        req.params.id,
        req.user.role,
        req.user.id,
        req.query.limit ?? 30,
        req.query.offset ?? 0,
      );
      return {
        items: groups.map((g) => ({
          id: g.id,
          classroomId: g.classroom_id,
          name: g.name,
          members: db.all(
            `SELECT u.id,u.name,gm.role FROM group_members gm JOIN users u ON u.id=gm.user_id
        WHERE gm.group_id=? ORDER BY u.id`,
            g.id,
          ),
        })),
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
      db.transaction(() => {
        groupAccess(db, req.user, req.params.id);
        const current = db.all<{ user_id: string }>(
          "SELECT user_id FROM group_members WHERE group_id=?",
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
          db.run(
            "UPDATE group_members SET role=? WHERE group_id=? AND user_id=?",
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
      classroomAccess(db, req.user, req.params.id);
      db.run(
        "UPDATE classrooms SET paused=? WHERE id=?",
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
      const classroom = classroomAccess(db, req.user, req.params.id);
      const count = (sql: string) =>
        db.get<{ n: number }>(sql, classroom.id)!.n;
      return {
        classroomId: classroom.id,
        paused: !!classroom.paused,
        enrolledStudents: count(
          "SELECT count(*) n FROM memberships WHERE classroom_id=?",
        ),
        groups: count("SELECT count(*) n FROM groups WHERE classroom_id=?"),
        publishedMissions: count(
          "SELECT count(*) n FROM missions WHERE classroom_id=? AND status='published'",
        ),
        submissions: count(
          "SELECT count(*) n FROM submissions s JOIN missions m ON m.id=s.mission_id WHERE m.classroom_id=?",
        ),
        awaitingReview:
          count(`SELECT count(*) n FROM submissions s JOIN missions m ON m.id=s.mission_id
        WHERE m.classroom_id=? AND NOT EXISTS(SELECT 1 FROM evaluations e WHERE e.submission_id=s.id AND e.submission_version=s.version)`),
        openHelpRequests:
          count(`SELECT count(*) n FROM help_requests h JOIN groups g ON g.id=h.group_id
        WHERE g.classroom_id=? AND h.resolved_at IS NULL`),
        updatedAt: new Date().toISOString(),
      };
    },
  );
}
