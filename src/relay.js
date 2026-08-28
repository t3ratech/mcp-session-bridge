import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * The relay socket the native host listens on and MCP servers connect to.
 * `T3RNEL_SESSION_SOCKET` overrides the default; tests use that to keep runs
 * isolated. On Windows this is a named pipe; elsewhere a Unix domain socket
 * inside a private directory under the user's home.
 */
export function resolveSocketPath(env = process.env, os = platform(), home = homedir()) {
  const override = env.T3RNEL_SESSION_SOCKET;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  if (os === "win32") {
    return "\\\\.\\pipe\\t3rnel-session-bridge";
  }
  return join(home, ".t3rnel", "session-bridge", "bridge.sock");
}

/** Creates the socket's parent directory with owner-only permissions. */
export function ensureSocketDir(socketPath, os = platform()) {
  if (os === "win32") return;
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
}
