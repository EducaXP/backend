import Fastify, {
  type FastifyError,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { Store } from "./db.js";
import { ApiError, type User } from "./domain.js";
import {
  authentication,
  digest,
  hashPassword,
  issueSession,
  verifyPassword,
} from "./auth.js";
import { object, text } from "./schemas.js";
import { classroomRoutes } from "./routes/classrooms.js";
import { missionRoutes } from "./routes/missions.js";
import { learningRoutes } from "./routes/learning.js";

export interface AppOptions {
  databasePath?: string;
  logger?: boolean;
  corsOrigins?: string[];
  sessionHours?: number;
  enableDocs?: boolean;
  rateLimitMax?: number;
}
export async function buildApp(options: AppOptions = {}) {
  const db = new Store(options.databasePath ?? ":memory:");
  const app = Fastify({
    logger: options.logger
      ? {
          redact: ["req.headers.authorization", "req.headers.cookie"],
          level: "info",
        }
      : false,
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array" } },
  }).withTypeProvider<TypeBoxTypeProvider>();
  app.addHook("onClose", async () => db.close());
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        });
    if (error.validation)
      return reply
        .code(400)
        .send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Confira os campos enviados.",
            details: error.validation.map((v) => ({
              path: v.instancePath,
              rule: v.keyword,
            })),
          },
        });
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({
          error: {
            code: error.statusCode === 429 ? "RATE_LIMITED" : "INVALID_REQUEST",
            message:
              error.statusCode === 429
                ? "Muitas tentativas. Aguarde um minuto e tente novamente."
                : "Requisição inválida.",
          },
        });
    }
    // Do not log payloads, SQL parameters or database error messages with student data.
    req.log.error(
      { requestId: req.id, errorType: error.name },
      "Falha interna",
    );
    return reply
      .code(500)
      .send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Não foi possível concluir. Tente novamente.",
        },
      });
  });
  app.setNotFoundHandler(async (_req, reply) =>
    reply
      .code(404)
      .send({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } }),
  );
  await app.register(cors, {
    origin: options.corsOrigins ?? [],
    credentials: false,
  });
  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 300,
    timeWindow: "1 minute",
  });
  if (options.enableDocs) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "EducaXP API",
          description:
            "Backend do MVP. Planejamento por modelo local; sem monitoramento de atenção.",
          version: "0.1.0",
        },
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        },
      },
    });
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { persistAuthorization: false },
    });
  }
  app.get("/health", { schema: { tags: ["Saúde"] } }, async () => {
    db.get("SELECT 1");
    return { status: "ok", service: "educaxp-api" };
  });
  const dummyHash = await hashPassword("unused-dummy-password");
  // Keep the IP budget generous for school Wi-Fi, and limit attempts per account separately.
  const checkLoginLimit = app.createRateLimit({
    max: 10,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const body = req.body as {
        login?: string;
        classCode?: string;
        alias?: string;
      };
      return digest(
        body.login
          ? `teacher:${body.login}`
          : `student:${body.classCode?.toUpperCase()}:${body.alias?.toLowerCase()}`,
      );
    },
  });
  const loginLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const limit = await checkLoginLimit(req);
    if (!limit.isAllowed && limit.isExceeded) {
      reply.header("Retry-After", limit.ttlInSeconds);
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Muitas tentativas para esta conta. Aguarde um minuto.",
      );
    }
  };
  const sessionHours = options.sessionHours ?? 12;
  if (
    !Number.isFinite(sessionHours) ||
    sessionHours < 1 ||
    sessionHours > 168
  ) {
    await app.close();
    throw new Error("SESSION_HOURS deve estar entre 1 e 168.");
  }
  app.post(
    "/api/v1/auth/login",
    {
      preHandler: loginLimit,
      schema: {
        tags: ["Acesso"],
        body: object({
          login: text(100),
          password: Type.String({ minLength: 1, maxLength: 128 }),
        }),
      },
    },
    async (req) => {
      const user = db.get<User & { password_hash: string }>(
        "SELECT * FROM users WHERE login=? AND role='teacher'",
        req.body.login,
      );
      const valid = await verifyPassword(
        req.body.password,
        user?.password_hash ?? dummyHash,
      );
      if (!user || !valid)
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Credenciais inválidas.",
        );
      return issueSession(db, user.id, sessionHours);
    },
  );
  app.post(
    "/api/v1/auth/student-session",
    {
      preHandler: loginLimit,
      schema: {
        tags: ["Acesso"],
        body: object({
          classCode: text(20),
          alias: text(24),
          pin: Type.String({ pattern: "^[0-9]{6}$" }),
        }),
      },
    },
    async (req) => {
      const user = db.get<User & { password_hash: string }>(
        `SELECT u.* FROM users u
      JOIN memberships m ON m.user_id=u.id JOIN classrooms c ON c.id=m.classroom_id
      WHERE c.join_code=? AND m.alias=? AND u.role='student'`,
        req.body.classCode.toUpperCase(),
        req.body.alias.toLowerCase(),
      );
      const valid = await verifyPassword(
        req.body.pin,
        user?.password_hash ?? dummyHash,
      );
      if (!user || !valid)
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Credenciais inválidas.",
        );
      return issueSession(db, user.id, sessionHours);
    },
  );
  await app.register(
    async (secured) => {
      secured.decorateRequest("user");
      secured.addHook("onRequest", authentication(db));
      secured.addHook("onRoute", (route) => {
        route.schema = { ...route.schema, security: [{ bearerAuth: [] }] };
      });
      secured.get("/me", async (req) => ({
        id: req.user.id,
        name: req.user.name,
        role: req.user.role,
        schoolId: req.user.school_id,
      }));
      secured.post("/auth/logout", async (req, reply) => {
        db.run(
          "DELETE FROM sessions WHERE token_hash=?",
          digest(req.headers.authorization!.slice(7)),
        );
        return reply.code(204).send();
      });
      classroomRoutes(secured, db);
      missionRoutes(secured, db);
      learningRoutes(secured, db);
    },
    { prefix: "/api/v1" },
  );
  await app.ready();
  return { app, db };
}
