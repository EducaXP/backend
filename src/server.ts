import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await buildApp({ ...config, logger: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(
    { errorType: error instanceof Error ? error.name : "Unknown" },
    "Não foi possível iniciar o servidor.",
  );
  await app.close();
  process.exitCode = 1;
}
