export interface User {
  id: string;
  school_id: string;
  role: "teacher" | "student";
  name: string;
  login: string;
  avatar_item: string;
  eco_mode: number;
}
export interface Classroom {
  id: string;
  school_id: string;
  teacher_id: string;
  name: string;
  join_code: string;
  paused: number;
}
export interface Group {
  id: string;
  classroom_id: string;
  name: string;
}
export interface MissionRow {
  id: string;
  classroom_id: string;
  status: "draft" | "published" | "closed";
  version: number;
  content: string;
  created_at: string;
}
export interface SubmissionRow {
  id: string;
  mission_id: string;
  group_id: string;
  version: number;
  content: string;
  updated_at: string;
}
export interface EvaluationRow {
  id: string;
  submission_id: string;
  submission_version: number;
  feedback: string;
  scores: string;
  created_at: string;
}
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function requireFound<T>(value: T | undefined): T {
  if (!value) throw new ApiError(404, "NOT_FOUND", "Recurso não encontrado.");
  return value;
}
export const now = () => new Date().toISOString();
export const catalog = [
  { id: "basic", name: "Explorador", requiredXp: 0 },
  { id: "headphones", name: "Fone cósmico", requiredXp: 100 },
  { id: "cape", name: "Capa da colaboração", requiredXp: 200 },
  { id: "backpack", name: "Mochila de investigação", requiredXp: 300 },
] as const;
