export interface Port {
  port: number
  protocol: string
  state: string
  pid: number | null
  process_name: string | null
  parent_process: string | null
  local_address: string
  foreign_address: string | null
  started_at: string | null
  service_tag: string | null
  cmdline_preview?: string | null
  username?: string | null
  cwd?: string | null
  container_hint?: string | null
}

/**
 * Unique per socket row (selection, row keys, refresh diff).
 * Includes state + remote endpoint so distinct connections do not share one key.
 */
export function stablePortRowKey(p: Port): string {
  return [
    p.protocol,
    p.local_address,
    String(p.pid ?? ''),
    p.state.toUpperCase(),
    p.foreign_address ?? '',
  ].join('\u001f')
}

export type KillResult = {
  success: boolean
  error?: string
  dry_run?: boolean
  message?: string
  pid?: number
  process_name?: string
  port?: number
}

export type KillOptions = {
  dryRun?: boolean
  port?: number
}

export interface PortManagerAPI {
  getPorts: (filter?: { state?: string; process?: string }) => Promise<{ ports: Port[]; count: number }>
  killPort: (port: number, options?: { dryRun?: boolean }) => Promise<KillResult>
  killPid: (pid: number, options?: KillOptions) => Promise<KillResult>
}

export type ThemeMode = 'dark' | 'light'

export function resolveEffectiveTheme(theme: ThemeMode): 'light' | 'dark' {
  return theme
}

export interface PortmanSettings {
  theme: ThemeMode
  refreshInterval: number
  accentColor: string
  startupOnLogin: boolean
  /** Leave out ports the operating system itself holds (see portKinds.ts). */
  hideSystem: boolean
  /** Which ports the list shows when PortMan opens. */
  defaultFilter: 'ALL' | 'LISTEN'
  /** Ask for the port number (or KILL) to be typed before killing. */
  confirmByTyping: boolean
}
