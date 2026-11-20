declare namespace Cloudflare {
  interface Env {
    AGENT_TOKEN: string;
    INGEST_TOKEN: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
