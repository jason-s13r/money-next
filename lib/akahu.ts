import { AkahuClient } from "akahu";

// No `server-only` here either — scripts/ingest.ts imports this from plain Node.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`);
  return value;
}

/// Akahu identifies the *app* with an app token and the *user* whose accounts
/// we're reading with a separate access token. For a personal dashboard the
/// user token is your own, issued from my.akahu.nz.
export function akahuClient() {
  return new AkahuClient({ appToken: requireEnv("AKAHU_APP_ID_TOKEN") });
}

export function akahuUserToken(): string {
  return requireEnv("AKAHU_USER_ACCESS_TOKEN");
}
