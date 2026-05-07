import type { FastifyInstance } from "fastify";

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({ status: "ok", time: new Date().toISOString() }));
}
