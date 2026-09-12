import { existsSync } from "node:fs";
import { Store } from "./db.js";
import { readDatabaseUrl } from "./config.js";
if (existsSync(".env")) process.loadEnvFile(".env");
try {
  const store = await Store.connect(readDatabaseUrl(process.env));
  await store.close();
  console.log("Migrações do PostgreSQL aplicadas.");
} catch {
  console.error(
    "Não foi possível aplicar as migrações. Confira DATABASE_URL, rede e permissões.",
  );
  process.exitCode = 1;
}
