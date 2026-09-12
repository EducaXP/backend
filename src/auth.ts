import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Store } from "./db.js";
import { ApiError, type User } from "./domain.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
}
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, encoded] = hash.split(":");
  if (!salt || !encoded) return false;
  const expected = Buffer.from(encoded, "hex");
  const actual = await derive(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const digest = (input: string) =>
  createHash("sha256").update(input).digest("hex");
export function issueSession(db: Store, userId: string, sessionHours: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionHours * 3600000;
  db.run("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
  db.run(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    digest(token),
    userId,
    expiresAt,
  );
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}
export function authentication(db: Store) {
  return async (request: FastifyRequest) => {
    const token = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    if (!token)
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Entre novamente para continuar.",
      );
    const user = db.get<User>(
      `SELECT u.id,u.school_id,u.role,u.name,u.login,u.avatar_item,u.eco_mode
      FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`,
      digest(token),
      Date.now(),
    );
    if (!user)
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Sessão inválida ou expirada. Entre novamente.",
      );
    request.user = user;
  };
}
export async function teacher(request: FastifyRequest) {
  if (request.user.role !== "teacher")
    throw new ApiError(403, "FORBIDDEN", "Esta ação é exclusiva do educador.");
}
export async function student(request: FastifyRequest) {
  if (request.user.role !== "student")
    throw new ApiError(403, "FORBIDDEN", "Esta ação é exclusiva do estudante.");
}
