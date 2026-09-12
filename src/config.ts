import { existsSync } from "node:fs";

import { readAIConfig } from "./ai.js";
export function loadConfig() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const port = Number(process.env.PORT ?? 3333);
  const sessionHours = Number(process.env.SESSION_HOURS ?? 12);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT deve ser uma porta válida.");
  if (!Number.isFinite(sessionHours) || sessionHours < 1 || sessionHours > 168)
    throw new Error("SESSION_HOURS deve estar entre 1 e 168.");
  return {
    ai: readAIConfig(process.env),
    host: process.env.HOST ?? "127.0.0.1",
    port,
    sessionHours,
    databaseUrl: readDatabaseUrl(process.env),
    corsOrigins: (
      process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    enableDocs:
      process.env.ENABLE_DOCS === "true" ||
      (process.env.ENABLE_DOCS === undefined &&
        process.env.NODE_ENV !== "production"),
  };
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_URL?.trim();
  if (!value)
    throw new Error(
      "Configure DATABASE_URL com a conexão interna do PostgreSQL no Coolify.",
    );
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.slice(1)
    )
      throw new Error();
  } catch {
    throw new Error(
      "DATABASE_URL deve ser uma URL PostgreSQL válida com nome do banco.",
    );
  }
  return value;
}
