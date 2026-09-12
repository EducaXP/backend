import { Type, type Static } from "@sinclair/typebox";

export const object = <T extends Parameters<typeof Type.Object>[0]>(
  properties: T,
) => Type.Object(properties, { additionalProperties: false });
export const text = (max = 160) =>
  Type.String({ minLength: 1, maxLength: max, pattern: "\\S" });
export const uuid = Type.String({ format: "uuid" });
export const idParams = object({ id: uuid });
export const version = Type.Integer({ minimum: 1 });
export const pagination = object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 100000, default: 0 }),
  ),
});
export const criterion = object({
  id: text(40),
  title: text(120),
  levels: Type.Array(text(800), { minItems: 4, maxItems: 4 }),
});
export const investigationQuestions = Type.Array(
  object({ id: text(40), topic: text(160), prompt: text(1500) }),
  { minItems: 1, maxItems: 10 },
);
export const missionContent = object({
  questions: Type.Optional(investigationQuestions),
  title: text(),
  objective: text(2000),
  subject: text(100),
  schoolYear: text(50),
  durationMinutes: Type.Integer({ minimum: 1, maximum: 240 }),
  offlineAlternative: text(2000),
  steps: Type.Array(
    object({
      title: text(),
      instructions: text(3000),
      mode: Type.Union([Type.Literal("screen"), Type.Literal("off_screen")]),
    }),
    { minItems: 1, maxItems: 12 },
  ),
  rubric: Type.Array(criterion, { minItems: 1, maxItems: 10 }),
  // A teacher-provided reference is pending verification, never an official alignment claim.
  bnccReference: Type.Optional(
    object({
      code: text(30),
      sourceUrl: Type.String({ format: "uri", maxLength: 500 }),
    }),
  ),
});
export type MissionContent = Static<typeof missionContent>;
export const missionEdit = object({
  baseVersion: version,
  content: missionContent,
});
export const submissionWrite = object({
  operationId: uuid,
  submissionId: uuid,
  missionId: uuid,
  groupId: uuid,
  baseVersion: Type.Integer({ minimum: 0 }),
  answers: Type.Optional(
    Type.Array(object({ questionId: text(40), text: text(2000) }), {
      maxItems: 10,
    }),
  ),
  evidence: Type.String({ maxLength: 12000 }),
  reflection: Type.String({ maxLength: 2000 }),
  completedSteps: Type.Array(Type.Integer({ minimum: 0, maximum: 11 }), {
    maxItems: 12,
    uniqueItems: true,
  }),
  channel: Type.Union([
    Type.Literal("digital"),
    Type.Literal("teacher_mediated"),
  ]),
});
export type SubmissionWrite = Static<typeof submissionWrite>;
export const evaluationWrite = object({
  submissionVersion: version,
  feedback: text(4000),
  recognizeParticipation: Type.Boolean(),
  scores: Type.Array(
    object({
      criterionId: text(40),
      level: Type.Integer({ minimum: 0, maximum: 3 }),
    }),
    { minItems: 1, maxItems: 10 },
  ),
});
export const avatarWrite = object({
  itemId: text(40),
  ecoMode: Type.Boolean(),
});
