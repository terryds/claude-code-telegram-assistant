/**
 * Best-effort reachable URL for the dashboard, for inclusion in Telegram
 * messages. The user reads those on their phone, so `localhost` links are
 * dead on arrival — prefer the machine's FQDN if it has a real domain, then
 * fall back to the host's LAN/public IPv4, with a DASHBOARD_URL env override
 * for setups behind a proxy or DNS name.
 */
import { hostname, networkInterfaces } from 'node:os';

let serverPort: number | null = null;

/** Called once by the HTTP server after binding, with the actual port. */
export function setDashboardPort(port: number | undefined): void {
  serverPort = port ?? null;
}

/**
 * The OS hostname, but only when it's a fully-qualified domain name that a
 * phone could plausibly resolve — i.e. it has a dot and isn't in a
 * link-local/private suffix like `.local` (mDNS) or `.lan`.
 */
function fqdnHostname(): string | null {
  const name = hostname().trim().replace(/\.$/, '').toLowerCase();
  if (!name.includes('.')) return null;
  if (/\.(local|localdomain|internal|intranet|lan|home|arpa)$/.test(name)) return null;
  return name;
}

function hostAddress(): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local
      candidates.push({ name, address: info.address });
    }
  }
  if (candidates.length === 0) return null;
  // Prefer real NICs (en0/eth0) over VPN/tunnel interfaces (utun, tailscale0).
  const physical = candidates.find((c) => /^(en|eth)\d/.test(c.name));
  return (physical ?? candidates[0]).address;
}

export function getDashboardUrl(): string | null {
  const override = process.env.DASHBOARD_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  if (serverPort == null) return null;
  const host = fqdnHostname() ?? hostAddress();
  if (!host) return null;
  return `http://${host}:${serverPort}`;
}
