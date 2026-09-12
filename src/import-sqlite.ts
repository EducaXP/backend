import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { dataTables } from "./migrations.js";
import type { Store } from "./db.js";

export async function importSQLite(sourcePath: string, target: Store) {
  const path = resolve(sourcePath);
  if (!existsSync(path))
    throw new Error("Arquivo SQLite de origem não encontrado.");
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    source.exec("BEGIN");
    const version = source.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 1)
      throw new Error("Versão do SQLite incompatível. Importação cancelada.");
    if (
      source.prepare("PRAGMA integrity_check").get()?.integrity_check !==
        "ok" ||
      source.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("A origem falhou na verificação de integridade.");
    return await target.transaction(async () => {
      // No merge or overwrite: repeated execution refuses a populated destination.
      for (const table of dataTables)
        if (await target.get(`SELECT 1 FROM "${table}" LIMIT 1`))
          throw new Error(
            "O PostgreSQL de destino precisa estar vazio. Nenhum registro foi alterado.",
          );
      const counts: Record<string, number> = {};
      for (const table of dataTables) {
        const columns = (
          await target.all<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
            table,
          )
        ).map((c) => c.column_name);
        const sourceColumns = source
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((c) => c.name);
        if (
          !columns.length ||
          columns.length !== sourceColumns.length ||
          columns.some((c) => !sourceColumns.includes(c))
        )
          throw new Error(
            "Estrutura da origem incompatível. Importação cancelada.",
          );
        const names = columns
          .map((c) => '"' + c.replaceAll('"', '""') + '"')
          .join(",");
        const sql = `INSERT INTO "${table}" (${names}) VALUES (${columns.map((_, i) => "$" + (i + 1)).join(",")})`;
        counts[table] = 0;
        for (const row of source
          .prepare(`SELECT * FROM "${table}"`)
          .iterate()) {
          await target.run(sql, ...columns.map((c) => row[c]));
          counts[table]++;
        }
        const persisted = await target.get<{ n: number }>(
          `SELECT count(*) AS n FROM "${table}"`,
        );
        if (persisted?.n !== counts[table])
          throw new Error(
            "A contagem de registros não confere. Importação cancelada.",
          );
      }
      return counts;
    });
  } finally {
    source.close();
  }
}
