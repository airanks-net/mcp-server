// Same endpoints and behavior as node-cli/air.js and API-CONTRACT.md: GET /v1/domains/{host}
// (poll while ai_files.status == "pending", honor 429 Retry-After), GET /v1/search?q=, GET /user.
import { resolveToken, shouldAttachToken } from "./auth.js";

export const API_BASE = process.env.AIR_API_BASE || "https://airanks.net/api/v1";
export const USER_URL = `${API_BASE.replace(/\/v1$/, "")}/user`;
const VERSION = "1.0.0";
// RFC 9110 product-token + contact-URL convention — matches the other AIR clients' UA shape.
const UA = `air-mcp/${VERSION} (+https://airanks.net)`;
const FETCH_TIMEOUT_MS = 10_000;

export interface AiFiles {
  status: "ready" | "pending";
  llms_txt: boolean;
  llms_full_txt: boolean;
  ai_txt: boolean;
  robots_txt: boolean;
  json_ld: boolean;
  json_ld_types: string[];
  robots_ai_agents: Record<string, "allowed" | "blocked" | "partial">;
}

export interface DomainData {
  hostname: string;
  air_score: number;
  percentile: number | null;
  tracked: boolean;
  occurrences: number;
  phrases_count: number;
  brands_count: number;
  summary: string | null;
  ai_files: AiFiles;
}

export interface SearchHit {
  hostname?: string;
  name?: string;
  text?: string;
  air_score: number;
}

export interface SearchData {
  domains: SearchHit[];
  brands: SearchHit[];
  phrases: SearchHit[];
}

// Mirrors toolbar/extension/utils/hostname.ts and the API's HostnameNormalizer.
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function normalizeHostname(rawUrl: string): string | null {
  const raw = String(rawUrl ?? "").trim();
  if (!raw) return null;
  if (/\s/.test(raw)) return null; // multi-word input is a search query, not a host
  let url: URL;
  try {
    url = new URL(SCHEME_RE.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.startsWith("[") || IPV4_RE.test(hostname)) return null;
  if (hostname.startsWith("www.")) hostname = hostname.slice(4);
  if (!hostname.includes(".") || hostname.endsWith(".")) return null;
  return hostname;
}

async function apiFetch(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const resolved = resolveToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { "User-Agent": UA };
  if (shouldAttachToken(url, resolved) && resolved.token) headers.Authorization = `Bearer ${resolved.token}`;
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function apiErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? body?.message ?? `API returned ${res.status}`;
}

interface DomainFetchResult {
  data?: DomainData;
  datasetVersion?: number | null;
  rateLimitedSeconds?: number;
}

async function fetchDomainOnce(host: string): Promise<DomainFetchResult> {
  const res = await apiFetch(`${API_BASE}/domains/${encodeURIComponent(host)}`);
  if (res.status === 429) {
    const retryAfter = Math.max(1, Number(res.headers.get("Retry-After")) || 30);
    return { rateLimitedSeconds: retryAfter };
  }
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  const json = await res.json();
  return { data: json.data, datasetVersion: json.meta?.dataset_version ?? null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LookupResult {
  data: DomainData;
  datasetVersion: number | null;
  pending: boolean;
}

// A synchronous MCP tool call can't sit on the CLI's ~3min poll loop, so this wall-clock budget
// is much shorter: a couple of short polls, then hand back a clear "still gathering" note instead
// of the fake all-zero score the server would otherwise cast a not-yet-hydrated domain to.
// Overridable for tests / patient callers via env.
const POLL_MS = Number(process.env.AIR_MCP_POLL_MS) || 3_000;
const POLL_MAX_MS = Number(process.env.AIR_MCP_POLL_MAX_MS) || 12_000;

export async function lookupDomain(
  host: string,
  { pollMs = POLL_MS, pollMaxMs = POLL_MAX_MS }: { pollMs?: number; pollMaxMs?: number } = {},
): Promise<LookupResult> {
  const deadline = Date.now() + pollMaxMs;
  for (;;) {
    const result = await fetchDomainOnce(host);
    if (result.rateLimitedSeconds !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`rate limited (429) — retry-after ${result.rateLimitedSeconds}s outlived the lookup budget; try again shortly`);
      }
      await sleep(Math.min(result.rateLimitedSeconds * 1000, remaining));
      continue;
    }
    const data = result.data!;
    const pending = data.ai_files?.status === "pending";
    const remaining = deadline - Date.now();
    if (!pending || remaining <= 0) {
      return { data, datasetVersion: result.datasetVersion ?? null, pending };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function fetchSearch(q: string): Promise<{ data: SearchData; datasetVersion: number | null }> {
  const res = await apiFetch(`${API_BASE}/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  const json = await res.json();
  return { data: json.data, datasetVersion: json.meta?.dataset_version ?? null };
}
