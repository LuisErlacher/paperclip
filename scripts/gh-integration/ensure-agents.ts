#!/usr/bin/env -S pnpm tsx
/**
 * Idempotently ensures the global gh-analyzer and gh-codador agent records exist
 * for a given company.
 *
 * Usage:
 *   PAPERCLIP_API_URL=http://localhost:3100 \
 *   PAPERCLIP_API_KEY=<admin-token> \
 *   PAPERCLIP_COMPANY_ID=<uuid> \
 *   ANTHROPIC_API_KEY_SECRET_ID=<secret-uuid> \
 *   pnpm tsx scripts/gh-integration/ensure-agents.ts
 */

type AgentSpec = {
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
};

const ANALYZER: AgentSpec = {
  name: "gh-analyzer",
  adapterType: "process",
  adapterConfig: {
    command: "node",
    args: ["/app/agents/gh-analyzer/dist/index.js"],
    timeoutSec: 120,
    env: {
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: mustEnv("ANTHROPIC_API_KEY_SECRET_ID") },
    },
  },
};

const CODADOR: AgentSpec = {
  name: "gh-codador",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-4-6" },
};

async function main(): Promise<void> {
  const apiUrl = mustEnv("PAPERCLIP_API_URL").replace(/\/$/, "");
  const apiKey = mustEnv("PAPERCLIP_API_KEY");
  const companyId = mustEnv("PAPERCLIP_COMPANY_ID");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const spec of [ANALYZER, CODADOR]) {
    const existing = await fetchExistingByName(apiUrl, headers, companyId, spec.name);
    if (existing) {
      console.log(`[ensure-agents] ${spec.name} exists (id=${existing.id}); patching adapter config.`);
      const res = await fetch(`${apiUrl}/api/agents/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          adapterType: spec.adapterType,
          adapterConfig: spec.adapterConfig,
        }),
      });
      if (!res.ok) throw new Error(`PATCH ${spec.name}: ${res.status} ${await res.text()}`);
    } else {
      console.log(`[ensure-agents] creating ${spec.name}`);
      const res = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...spec }),
      });
      if (!res.ok) throw new Error(`POST ${spec.name}: ${res.status} ${await res.text()}`);
      const created = (await res.json()) as { id: string };
      console.log(`[ensure-agents] created ${spec.name} (id=${created.id})`);
    }
  }
  console.log("[ensure-agents] done.");
}

async function fetchExistingByName(
  apiUrl: string,
  headers: Record<string, string>,
  companyId: string,
  name: string,
): Promise<{ id: string } | null> {
  const res = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, { headers });
  if (!res.ok) throw new Error(`list agents: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
  const items = Array.isArray(body) ? body : body.items ?? [];
  return items.find((a) => a.name === name) ?? null;
}

function mustEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
