/**
 * Best-effort reachable URL for the dashboard, for inclusion in Telegram
 * messages. The user reads those on their phone, so `localhost` links are
 * dead on arrival — resolve the host's LAN/public IPv4 instead, with a
 * DASHBOARD_URL env override for setups behind a proxy or DNS name.
 */
import { networkInterfaces } from 'node:os';

let serverPort: number | null = null;

/** Called once by the HTTP server after binding, with the actual port. */
export function setDashboardPort(port: number | undefined): void {
  serverPort = port ?? null;
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
  const host = hostAddress();
  if (!host) return null;
  return `http://${host}:${serverPort}`;
}
