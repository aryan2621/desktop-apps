import type { Port } from './types'

/** Where operating-system programs live (macOS, Linux, Windows). */
const SYSTEM_PATHS = [
  '/system/',
  '/usr/libexec/',
  '/usr/sbin/',
  '/sbin/',
  '/library/apple/',
  '/usr/lib/systemd/',
  '/lib/systemd/',
  'c:\\windows\\',
]

/** Accounts the operating system runs its own services as. */
const SYSTEM_USERS = ['root', 'system', 'local service', 'network service']

/**
 * A port the operating system itself holds (Control Center, AirPlay, Remote Management…), not
 * one of the user's own apps or dev servers. Only a confident match counts: an unknown process
 * stays visible.
 */
export function isSystemPort(p: Port): boolean {
  // Containers' ports are published by root-owned helpers (docker-proxy) but are the user's.
  if (p.container_hint || (p.process_name ?? '').toLowerCase().includes('docker')) return false
  const cmd = (p.cmdline_preview ?? '').trim().toLowerCase()
  if (SYSTEM_PATHS.some((dir) => cmd.startsWith(dir))) return true
  const user = (p.username ?? '').toLowerCase()
  // macOS daemons run as _accounts (_mdnsresponder…); Windows services as NT AUTHORITY\….
  const account = user.includes('\\') ? user.slice(user.lastIndexOf('\\') + 1) : user
  if (user.startsWith('_') || user.startsWith('nt authority\\') || SYSTEM_USERS.includes(account)) {
    return true
  }
  return p.pid === 4 && p.process_name === 'System'
}

/** Well-known services that don't speak HTTP, so there's nothing to open in a browser. */
const NOT_WEB = new Set([
  'FTP Data', 'FTP', 'SSH', 'Telnet', 'SMTP', 'DNS', 'POP3', 'IMAP', 'SMTPS', 'SMTP Submission',
  'IMAPS', 'POP3S', 'MS SQL Server', 'Oracle', 'PPTP', 'ZooKeeper', 'Docker', 'Docker TLS', 'MySQL',
  'MariaDB', 'RDP', 'Erlang EPMD', 'PostgreSQL', 'VNC', 'RabbitMQ', 'VNC Server', 'Redis', 'Kafka',
  'MongoDB', 'MongoDB Shard', 'MongoDB Config',
])

/** Who can reach a socket, shortened for the table: "localhost", "all" (every network) or the IP. */
export function hostLabel(localAddress: string): string {
  const host = localAddress.slice(0, localAddress.lastIndexOf(':')).replace(/^\[|\]$/g, '')
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return 'localhost'
  if (host === '*' || host === '0.0.0.0' || host === '::' || host === '') return 'all'
  return host
}

/**
 * One row per socket the user can tell apart. A server listening on both IPv4 and IPv6 shows up
 * twice with the same address ("*:7000" from lsof) or as 127.0.0.1 and ::1; those become one row.
 * Kill works by PID, so merging them changes nothing about what gets stopped.
 */
export function dedupePorts(ports: Port[]): Port[] {
  const seen = new Set<string>()
  return ports.filter((p) => {
    const key = [
      p.protocol.toUpperCase(),
      p.port,
      p.pid ?? '',
      p.state.toUpperCase(),
      hostLabel(p.local_address),
      p.foreign_address ?? '',
    ].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const LOCAL_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::', '::1', '*', 'localhost', ''])

/** The address to open a listening port at in the browser, or null when it isn't a local web port. */
export function browserUrl(p: Port): string | null {
  if (p.protocol.toUpperCase() !== 'TCP' || p.state.toUpperCase() !== 'LISTEN') return null
  if (p.service_tag && NOT_WEB.has(p.service_tag)) return null
  const host = p.local_address.slice(0, p.local_address.lastIndexOf(':')).replace(/^\[|\]$/g, '')
  if (!LOCAL_HOSTS.has(host)) return null
  const scheme = p.port === 443 || p.port === 8443 ? 'https' : 'http'
  return `${scheme}://localhost:${p.port}`
}
