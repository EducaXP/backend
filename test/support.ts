import { PGlite } from "@electric-sql/pglite";
import { Store, type DatabaseDriver } from "../src/db.js";
import { buildApp, type AppOptions } from "../src/app.js";

export async function testStore(path?: string) {
  const db = new PGlite(path);
  let tail = Promise.resolve();
  const driver: DatabaseDriver = {
    listen: (changed) => db.listen("educaxp_changes", changed),
    async connect() {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((r) => {
        release = r;
      });
      await previous;
      return {
        release,
        async query(sql, values = []) {
          if (!values.length && sql.includes(";")) {
            const rows = await db.exec(sql);
            const last = rows.at(-1);
            return {
              rows: (last?.rows || []) as Record<string, unknown>[],
              rowCount: last?.affectedRows,
            };
          }
          const result = await db.query(sql, values);
          return {
            rows: result.rows as Record<string, unknown>[],
            rowCount: result.affectedRows,
          };
        },
      };
    },
    async end() {
      await db.close();
    },
  };
  const store = new Store(driver);
  await store.migrate();
  return store;
}
export async function buildTestApp(
  options: Omit<AppOptions, "store"> & { databasePath?: string } = {},
) {
  const { databasePath, ...rest } = options;
  const store = await testStore(databasePath);
  try {
    return await buildApp({ ...rest, store });
  } catch (error) {
    await store.close();
    throw error;
  }
}
