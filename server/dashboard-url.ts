/**
 * Best-effort reachable URL for the dashboard, for inclusion in Telegram
 * messages. The user reads those on their phone, so `localhost` links are
 * dead on arrival — and a LAN/VPN IP is little better (wrong network, goes
 * stale). Only the machine's full domain name (`hostname -f`) is trusted,
 * with a DASHBOARD_URL env override for setups behind a proxy or DNS name.
 * With neither, there is no URL: callers get null and must skip whatever
 * they wanted the link for.
 */
import { execFileSync } from 'node:child_process';

let serverPort: number | null = null;

/** Called once by the HTTP server after binding, with the actual port. */
export function setDashboardPort(port: number | undefined): void {
  serverPort = port ?? null;
}

let cachedFqdn: string | null | undefined;

/**
 * The machine's full domain name per `hostname -f`, but only when it's one a
 * phone could plausibly resolve — i.e. it has a dot and isn't in a
 * link-local/private suffix like `.local` (mDNS) or `.lan`.
 */
function fqdnHostname(): string | null {
  if (cachedFqdn !== undefined) return cachedFqdn;
  let name = '';
  try {
    name = execFileSync('hostname', ['-f'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    // no `hostname` binary or it errored — treat as no domain
  }
  name = name.replace(/\.$/, '').toLowerCase();
  const usable =
    name.includes('.') &&
    !/\.(local|localdomain|internal|intranet|lan|home|arpa)$/.test(name);
  cachedFqdn = usable ? name : null;
  return cachedFqdn;
}

export function getDashboardUrl(): string | null {
  const override = process.env.DASHBOARD_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  if (serverPort == null) return null;
  const host = fqdnHostname();
  if (!host) return null;
  return `http://${host}:${serverPort}`;
}
