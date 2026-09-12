import { existsSync } from "node:fs";
import { Store } from "./db.js";
import { readDatabaseUrl } from "./config.js";
import { importSQLite } from "./import-sqlite.js";

if (existsSync(".env")) process.loadEnvFile(".env");
let store: Store | undefined;
try {
  const source = process.argv[2];
  if (!source)
    throw new Error("Uso: npm run db:import-sqlite -- /caminho/educaxp.db");
  store = await Store.connect(readDatabaseUrl(process.env));
  const counts = await importSQLite(source, store);
  console.log("Importação concluída. Registros por tabela:", counts);
} catch {
  console.error(
    "Importação não concluída. Confira a conexão, a integridade/versão da origem e se o destino está vazio. Registros da importação são revertidos em caso de falha.",
  );
  process.exitCode = 1;
} finally {
  await store?.close();
}
