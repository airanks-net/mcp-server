import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeHostname, lookupDomain, fetchSearch, type DomainData } from "./api.js";

function percentileLabel(p: number | null): string | null {
  if (p == null) return null;
  return `top ${Math.max(1, Math.round((1 - p) * 100))}%`;
}

// Shared by air_rank and air_files — both key off the same domain lookup + pending state.
async function resolveDomain(domain: string) {
  const host = normalizeHostname(domain);
  if (!host) {
    return { error: `"${domain}" is not a valid domain (multi-word input, IPs, and localhost are rejected — use a bare hostname like "example.com").` };
  }
  try {
    const result = await lookupDomain(host);
    return { host, result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function pendingContent(host: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Still gathering data for ${host} — this is the first look at this domain, and AIR hydrates AI-file/robots data server-side on first sight. Try again in a minute or two.`,
      },
    ],
    structuredContent: { hostname: host, pending: true },
  };
}

const DomainInput = z.object({
  domain: z.string().min(1).describe('A bare hostname or URL, e.g. "example.com" or "https://example.com". "www." is stripped automatically.'),
}).strict();

const SearchInput = z.object({
  query: z.string().min(1).describe("Free-text search across tracked domains, brands, and phrases."),
}).strict();

export function registerTools(server: McpServer): void {
  server.registerTool(
    "air_rank",
    {
      title: "AIR Score for a Domain",
      description: `Look up a website's AIR score — the AI optimization ranking from airanks.net (${"https://airanks.net"}), based on how often and how well AI answer engines (ChatGPT, etc.) cite the domain.

Returns: hostname, air_score (0-10), percentile, tracked (bool), occurrences, phrases_count, brands_count, summary.

A domain never seen before is hydrated on first lookup; if it's still gathering, this returns a "still gathering" note instead of a fake zero score — re-run the tool in a minute or two.

Use when: "what's the AIR score for stripe.com", "is example.com AI-optimized", "how visible is this site in ChatGPT answers".
Don't use when: you want to search across many sites/brands by keyword — use air_search instead.`,
      inputSchema: DomainInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ domain }: z.infer<typeof DomainInput>) => {
      const resolved = await resolveDomain(domain);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }], isError: true };
      }
      const { host, result } = resolved;
      if (result.pending) return pendingContent(host);

      const d: DomainData = result.data;
      const pct = percentileLabel(d.percentile);
      const output = {
        hostname: d.hostname,
        air_score: d.air_score,
        percentile: d.percentile,
        percentile_label: pct,
        tracked: d.tracked,
        occurrences: d.occurrences,
        phrases_count: d.phrases_count,
        brands_count: d.brands_count,
        summary: d.summary,
        dataset_version: result.datasetVersion,
        page_url: `https://airanks.net/page?d=${d.hostname}`,
      };
      const lines = [
        `${d.hostname} — AIR ${d.air_score}/10${pct ? ` (${pct})` : ""}`,
        d.tracked
          ? `tracked — ${d.occurrences} occurrences · ${d.phrases_count} phrases · ${d.brands_count} brands`
          : "not tracked yet — no AI answer has cited this domain",
      ];
      if (d.summary) lines.push("", d.summary);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "air_files",
    {
      title: "AI-File Presence for a Domain",
      description: `Check whether a website exposes the AI-agent discovery files AIR tracks — llms.txt, llms-full.txt, ai.txt, robots.txt, JSON-LD structured data — plus per-agent robots.txt verdicts (allowed/blocked/partial) for known AI crawlers, from airanks.net.

Returns: ai_files presence booleans, json_ld_types, and robots_ai_agents (a map of agent name -> "allowed"|"blocked"|"partial").

If the domain is still gathering (first-ever lookup), returns a "still gathering" note instead of guessing — re-run in a minute or two.

Use when: "does example.com have an llms.txt", "is GPTBot blocked on this site", "check this domain's AI crawler access".`,
      inputSchema: DomainInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ domain }: z.infer<typeof DomainInput>) => {
      const resolved = await resolveDomain(domain);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }], isError: true };
      }
      const { host, result } = resolved;
      if (result.pending) return pendingContent(host);

      const f = result.data.ai_files;
      const lines = [`${result.data.hostname} — AI files`];
      lines.push(
        `llms.txt: ${f.llms_txt ? "yes" : "no"}  llms-full.txt: ${f.llms_full_txt ? "yes" : "no"}  ai.txt: ${f.ai_txt ? "yes" : "no"}  robots.txt: ${f.robots_txt ? "yes" : "no"}  json-ld: ${f.json_ld ? "yes" : "no"}${f.json_ld_types?.length ? ` (${f.json_ld_types.join(", ")})` : ""}`,
      );
      const agents = Object.entries(f.robots_ai_agents ?? {});
      if (agents.length) {
        lines.push("AI crawler verdicts:");
        for (const [agent, verdict] of agents) lines.push(`  ${agent}: ${verdict}`);
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { hostname: result.data.hostname, ai_files: f, dataset_version: result.datasetVersion },
      };
    },
  );

  server.registerTool(
    "air_search",
    {
      title: "Search AIR Domains, Brands, and Phrases",
      description: `Search airanks.net's AI-optimization rankings for matching domains, brands, and tracked phrases by keyword.

Returns: {domains, brands, phrases} arrays, each item with a name/hostname/text and its air_score (0-10).

Use when: "find AI-ranked competitors to X", "which domains rank for 'best crm software'", "search AIR for brand Y".
Don't use when: you already know the exact domain — use air_rank instead.`,
      inputSchema: SearchInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query }: z.infer<typeof SearchInput>) => {
      try {
        const { data, datasetVersion } = await fetchSearch(query);
        const total = (data.domains?.length ?? 0) + (data.brands?.length ?? 0) + (data.phrases?.length ?? 0);
        if (total === 0) {
          return { content: [{ type: "text" as const, text: `No matches for "${query}" — try a broader term or look up an exact domain with air_rank.` }] };
        }
        const lines = [`search "${query}"`];
        const buckets: Array<[string, { name: (h: any) => string }]> = [
          ["domains", { name: (h) => h.hostname }],
          ["brands", { name: (h) => h.name }],
          ["phrases", { name: (h) => h.text }],
        ];
        for (const [key, { name }] of buckets) {
          const hits = (data as any)[key] ?? [];
          if (!hits.length) continue;
          lines.push("", key + ":");
          for (const hit of hits) lines.push(`  ${name(hit)}  AIR ${hit.air_score}/10`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: { query, ...data, dataset_version: datasetVersion },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
