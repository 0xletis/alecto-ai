import { config } from "dotenv";
import { buildServer } from "./server.js";

config({
  path: new URL("../../../.env", import.meta.url).pathname
});

const server = buildServer();

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 3000);

try {
  await server.listen({ host, port });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
