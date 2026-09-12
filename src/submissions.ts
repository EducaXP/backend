import { groupAccess, missionAccess } from "./access.js";
import { digest } from "./auth.js";
import type { Store } from "./db.js";
import { ApiError, now, type SubmissionRow, type User } from "./domain.js";
import type { MissionContent, SubmissionWrite } from "./schemas.js";

export const submissionView = (row: SubmissionRow) => ({
  id: row.id,
  missionId: row.mission_id,
  groupId: row.group_id,
  version: row.version,
  ...JSON.parse(row.content),
  updatedAt: row.updated_at,
});

export function writeSubmission(db: Store, user: User, input: SubmissionWrite) {
  // Canonical order makes retry fingerprints independent of JSON key ordering.
  const payload = {
    submissionId: input.submissionId,
    missionId: input.missionId,
    groupId: input.groupId,
    baseVersion: input.baseVersion,
    evidence: input.evidence,
    reflection: input.reflection,
    completedSteps: [...input.completedSteps].sort((a, b) => a - b),
    channel: input.channel,
  };
  const fingerprint = digest(JSON.stringify(payload));
  return db.transaction(() => {
    const group = groupAccess(db, user, input.groupId);
    const mission = missionAccess(db, user, input.missionId);
    if (group.classroom_id !== mission.classroom_id) {
      throw new ApiError(
        422,
        "CLASSROOM_MISMATCH",
        "Grupo e missão devem pertencer à mesma turma.",
      );
    }
    if (user.role !== "teacher" && input.channel === "teacher_mediated") {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "O registro mediado deve ser feito pelo educador.",
      );
    }
    const previous = db.get<{ fingerprint: string; response: string }>(
      "SELECT fingerprint,response FROM operations WHERE user_id=? AND operation_id=?",
      user.id,
      input.operationId,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Use uma nova operationId para um conteúdo diferente.",
        );
      }
      return { ...JSON.parse(previous.response), replayed: true };
    }
    if (mission.status === "draft")
      throw new ApiError(
        409,
        "MISSION_NOT_PUBLISHED",
        "Publique a missão antes de receber entregas.",
      );
    const content: MissionContent = JSON.parse(mission.content);
    if (input.completedSteps.some((step) => step >= content.steps.length)) {
      throw new ApiError(
        422,
        "INVALID_STEP",
        "A entrega contém uma etapa inexistente.",
      );
    }
    const current = db.get<SubmissionRow>(
      "SELECT * FROM submissions WHERE mission_id=? AND group_id=?",
      input.missionId,
      input.groupId,
    );
    if (
      current &&
      (current.id !== input.submissionId ||
        current.version !== input.baseVersion)
    ) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Existe uma versão mais recente. Preserve o rascunho local e revise as diferenças.",
        { current: submissionView(current) },
      );
    }
    if (!current && input.baseVersion !== 0) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "A primeira entrega deve usar baseVersion 0.",
        { current: null },
      );
    }
    if (
      !current &&
      db.get("SELECT 1 FROM submissions WHERE id=?", input.submissionId)
    ) {
      throw new ApiError(
        409,
        "ID_CONFLICT",
        "Escolha um novo identificador para a entrega.",
      );
    }
    const timestamp = now();
    const nextVersion = (current?.version ?? 0) + 1;
    const evidence = JSON.stringify({
      evidence: input.evidence,
      reflection: input.reflection,
      completedSteps: payload.completedSteps,
      channel: input.channel,
      receivedAfterClosure: mission.status === "closed",
    });
    if (current) {
      db.run(
        "UPDATE submissions SET version=?,content=?,updated_at=? WHERE id=?",
        nextVersion,
        evidence,
        timestamp,
        current.id,
      );
    } else {
      db.run(
        "INSERT INTO submissions(id,mission_id,group_id,version,content,updated_at) VALUES(?,?,?,?,?,?)",
        input.submissionId,
        input.missionId,
        input.groupId,
        nextVersion,
        evidence,
        timestamp,
      );
    }
    db.run(
      "INSERT INTO submission_revisions(submission_id,version,content,author_id,created_at) VALUES(?,?,?,?,?)",
      input.submissionId,
      nextVersion,
      evidence,
      user.id,
      timestamp,
    );
    const response = {
      submission: submissionView(
        db.get<SubmissionRow>(
          "SELECT * FROM submissions WHERE id=?",
          input.submissionId,
        )!,
      ),
      replayed: false,
    };
    db.run(
      "INSERT INTO operations(user_id,operation_id,fingerprint,response,created_at) VALUES(?,?,?,?,?)",
      user.id,
      input.operationId,
      fingerprint,
      JSON.stringify(response),
      timestamp,
    );
    return response;
  });
}
