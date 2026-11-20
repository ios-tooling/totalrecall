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
            script: 'export default { fetch() { return Response.json({ id: 1 }, { status: 201 }); } };',
          },
        ],
        bindings: {
          AGENT_TOKEN: "test-agent-token",
          INGEST_TOKEN: "test-ingest-token",
          ACCESS_TEAM_DOMAIN: "team.test",
          ACCESS_AUD: "test-review-audience",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
}));
