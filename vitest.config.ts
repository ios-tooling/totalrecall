import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // A stand-in for the Chief of Staff Worker the COS service binding points at.
        workers: [
          {
            name: "chief-of-staff-ingest",
            modules: true,
            compatibilityDate: "2026-11-01",
            // Accepts what the real one accepts: a POST to /events carrying the ingest token.
            script: `export default { fetch(request) {
              const ok = request.method === "POST" && new URL(request.url).pathname === "/events" && request.headers.get("authorization") === "Bearer test-cos-token";
              return ok ? Response.json({ id: 1 }, { status: 201 }) : Response.json({ error: "Unauthorized" }, { status: 401 });
            } };`,
          },
        ],
        bindings: {
          AGENT_TOKEN: "test-agent-token",
          INGEST_TOKEN: "test-ingest-token",
          ACCESS_TEAM_DOMAIN: "team.test",
          ACCESS_AUD: "test-review-audience",
          COS_INGEST_TOKEN: "test-cos-token",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
}));
