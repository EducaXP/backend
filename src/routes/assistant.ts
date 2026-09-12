import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { classroomAccess } from "../access.js";
import { teacher } from "../auth.js";
import type { Store } from "../db.js";
import { ApiError } from "../domain.js";
import {
  assistantRequest,
  validateProposal,
  type PlanningAgent,
} from "../planning-agent.js";
export function assistantRoutes(
  instance: FastifyInstance,
  db: Store,
  agent?: PlanningAgent,
) {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const budgets = new Map<string, { used: number; resetAt: number }>();
  const active = new Set<string>();
  app.get(
    "/planning/assistant/status",
    { preHandler: teacher, schema: { tags: ["Planejamento"] } },
    async () => ({ enabled: !!agent }),
  );
  app.post(
    "/planning/assistant",
    {
      preHandler: teacher,
      schema: { tags: ["Planejamento"], body: assistantRequest },
    },
    async (req, reply) => {
      classroomAccess(db, req.user, req.body.classroomId);
      if (!agent)
        throw new ApiError(
          503,
          "AI_NOT_CONFIGURED",
          "O assistente aguarda ativação. Você pode continuar com o modelo editável.",
        );
      if (Buffer.byteLength(JSON.stringify(req.body), "utf8") > 40000)
        throw new ApiError(
          413,
          "AI_CONTEXT_TOO_LARGE",
          "O planejamento está muito longo. Resuma o pedido ou comece uma nova conversa.",
        );
      if (active.has(req.user.id) || active.size >= 3)
        throw new ApiError(
          429,
          "AI_BUSY",
          "Já existe uma proposta em preparação. Aguarde para enviar outro pedido.",
        );
      const now = Date.now();
      for (const [key, item] of budgets)
        if (item.resetAt <= now) budgets.delete(key);
      const budget = budgets.get(req.user.id) || {
        used: 0,
        resetAt: now + 3600000,
      };
      if (budget.used >= 12) {
        reply.header("Retry-After", Math.ceil((budget.resetAt - now) / 1000));
        throw new ApiError(
          429,
          "AI_BUDGET_REACHED",
          "O limite de pedidos desta hora foi atingido. Você pode continuar editando sua atividade.",
        );
      }
      budget.used++;
      budgets.set(req.user.id, budget);
      active.add(req.user.id);
      const controller = new AbortController();
      const disconnected = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once("close", disconnected);
      const { classroomId: _classroomId, ...context } = req.body;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const proposal = await Promise.race([
          agent(context, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new ApiError(
                  504,
                  "AI_TIMEOUT",
                  "O assistente demorou a responder. Seu rascunho está salvo.",
                ),
              );
            }, 45000);
          }),
        ]);
        return {
          mode: "ai",
          requiresTeacherReview: true,
          bnccVerification: "pending",
          ...validateProposal(proposal),
        };
      } finally {
        clearTimeout(timer);
        active.delete(req.user.id);
        reply.raw.removeListener("close", disconnected);
      }
    },
  );
}
