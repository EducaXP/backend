import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { migrations } from "./migrations.js";

export interface Connection {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  release(): void;
}
export interface DatabaseDriver {
  connect(): Promise<Connection>;
  end(): Promise<void>;
}
const lockId = 17420301;
export class Store {
  private scope = new AsyncLocalStorage<Connection>();
  private closed = false;
  constructor(private driver: DatabaseDriver) {}
  static async connect(connectionString: string) {
    if (!/^postgres(?:ql)?:\/\//.test(connectionString))
      throw new Error("DATABASE_URL deve ser uma URL PostgreSQL.");
    const pool = new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 30000,
    });
    // Connection errors must not print URLs, credentials or query parameters.
    pool.on("error", () => {});
    const store = new Store(pool);
    try {
      await store.migrate();
      return store;
    } catch {
      await pool.end();
      throw new Error(
        "Não foi possível preparar o PostgreSQL. Confira DATABASE_URL, rede e permissões.",
      );
    }
  }
  private async query(sql: string, values: unknown[]) {
    const active = this.scope.getStore();
    const connection = active || (await this.driver.connect());
    try {
      const response = await connection.query(sql, values);
      const result = Array.isArray(response) ? response.at(-1) : response;
      // pg returns int8 aggregates as strings; API counts and epoch milliseconds stay numeric.
      const rows = (result?.rows || []).map((row: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "string" &&
            ["n", "xp", "expires_at"].includes(key) &&
            /^\d+$/.test(value)
              ? Number(value)
              : value,
          ]),
        ),
      );
      return { rows, rowCount: result?.rowCount };
    } finally {
      if (!active) connection.release();
    }
  }
  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return (await this.query(sql, params)).rows[0] as T | undefined;
  }
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.query(sql, params)).rows as T[];
  }
  async run(sql: string, ...params: unknown[]) {
    const r = await this.query(sql, params);
    return { changes: r.rowCount ?? 0 };
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return fn();
    const connection = await this.driver.connect();
    try {
      await connection.query("BEGIN");
      // Preserve the MVP's serialized write semantics across backend instances.
      await connection.query("SELECT pg_advisory_xact_lock($1)", [lockId]);
      const result = await this.scope.run(connection, fn);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async migrate() {
    await this.transaction(async () => {
      await this.run(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      );
      const versions = await this.all<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      if (
        versions.some((v, i) => v.version !== i + 1) ||
        versions.length > migrations.length
      )
        throw new Error("Histórico de migrações incompatível.");
      for (let i = versions.length; i < migrations.length; i++) {
        await this.run(migrations[i]!);
        await this.run(
          "INSERT INTO schema_migrations(version) VALUES($1)",
          i + 1,
        );
      }
    });
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.driver.end();
    }
  }
}
