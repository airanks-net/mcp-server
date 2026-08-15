// Shared auth contract (API-CONTRACT.md) — identical resolution order across every AIR client:
// AIR_API_KEY env > ~/.config/air/auth.json (file, host-scoped) > anonymous.
// `air login` in the node-cli, rust-cli, go-cli, or Composer client all write this same file,
// so this MCP server picks up whatever the user already logged into.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = join(homedir(), ".config", "air", "auth.json");

export interface ResolvedToken {
  token: string | null;
  source: "env" | "file" | "anonymous";
  host?: string;
  user?: { name?: string; email?: string };
  expiresAt?: string | null;
}

interface AuthFile {
  token?: string;
  host?: string;
  user?: { name?: string; email?: string };
  expires_at?: string | null;
}

function readAuth(authPath = AUTH_PATH): AuthFile | null {
  try {
    return JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveToken(env: NodeJS.ProcessEnv = process.env): ResolvedToken {
  if (env.AIR_API_KEY) return { token: env.AIR_API_KEY, source: "env" };
  const auth = readAuth();
  if (auth?.token) {
    return { token: auth.token, source: "file", user: auth.user, host: auth.host, expiresAt: auth.expires_at };
  }
  return { token: null, source: "anonymous" };
}

// A file-sourced token only rides to requests whose URL host matches the host it was minted for;
// an env token (explicit user intent) always attaches. Stops a saved token leaking if
// AIR_API_BASE is repointed at a different host.
export function shouldAttachToken(url: string, resolved: ResolvedToken): boolean {
  if (!resolved.token) return false;
  if (resolved.source === "env") return true;
  return Boolean(resolved.host) && new URL(url).host === resolved.host;
}
