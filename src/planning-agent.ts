import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  missionContent,
  missionChallenge,
  hasValidChallengeTable,
  investigationQuestions,
  object,
  text,
  uuid,
} from "./schemas.js";
import { ApiError } from "./domain.js";

const draftContent = Type.Omit(missionContent, ["bnccReference"]);
export const proposedContent = object({
  ...draftContent.properties,
  challenge: missionChallenge,
  questions: investigationQuestions,
});
export const assistantRequest = object({
  classroomId: uuid,
  instruction: text(4000),
  subject: text(100),
  schoolYear: text(50),
  durationMinutes: Type.Integer({ minimum: 1, maximum: 240 }),
  resources: Type.String({ maxLength: 1500 }),
  topics: Type.Optional(Type.Array(text(160), { maxItems: 10 })),
  currentDraft: Type.Optional(draftContent),
  history: Type.Optional(
    Type.Array(
      object({
        role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
        content: text(3000),
      }),
      { maxItems: 8 },
    ),
  ),
});
export const assistantOutput = object({
  reply: text(3000),
  content: proposedContent,
});
export type AssistantRequest = Static<typeof assistantRequest>;
export type AssistantProposal = Static<typeof assistantOutput>;
export type PlanningContext = Omit<AssistantRequest, "classroomId">;
// Provider-independent boundary; tests may inject a local deterministic agent.
export type PlanningAgent = (
  context: PlanningContext,
  signal: AbortSignal,
) => Promise<unknown>;
export function validateProposal(
  value: unknown,
  topics?: string[],
): AssistantProposal {
  if (!Value.Check(assistantOutput, value))
    throw new ApiError(
      502,
      "AI_INVALID_RESPONSE",
      "A proposta não tem todos os campos necessários. Seu rascunho foi preservado.",
    );
  if (
    new Set(value.content.rubric.map((c) => c.id)).size !==
      value.content.rubric.length ||
    new Set(value.content.questions.map((q) => q.id)).size !==
      value.content.questions.length ||
    !value.content.steps.some((s) => s.mode === "off_screen") ||
    !hasValidChallengeTable(value.content.challenge)
  )
    throw new ApiError(
      502,
      "AI_INVALID_RESPONSE",
      "A proposta precisa de critérios distintos, uma etapa fora da tela e tabelas com colunas completas. Seu rascunho foi preservado.",
    );
  if (
    topics?.some(
      (topic) =>
        !value.content.questions.some(
          (q) =>
            q.topic.trim().toLocaleLowerCase("pt-BR") ===
            topic.trim().toLocaleLowerCase("pt-BR"),
        ),
    )
  )
    throw new ApiError(
      502,
      "AI_INVALID_RESPONSE",
      "A proposta não cobriu todos os tópicos. Seu rascunho foi preservado.",
    );
  return value;
}
