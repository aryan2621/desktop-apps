import { invoke } from '@tauri-apps/api/tauri'
import type { KillResult, Port, PortManagerAPI } from '../types'

export async function getAutostartFromOs(): Promise<boolean | null> {
  if (!isTauriRuntime()) return null
  try {
    return await invoke<boolean>('get_autostart')
  } catch {
    return null
  }
}

export async function setAutostartOnOs(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('set_autostart', { enabled })
}

/** Opens the OS settings screen for login items / startup apps (macOS Login Items, Windows Startup, etc.). */
export async function openSystemStartupSettings(): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('open_startup_settings')
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Record<string, unknown>
  return Boolean(w.__TAURI_IPC__ ?? w.__TAURI_METADATA__)
}

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return invoke('rpc', { method, params })
}

type MockStore = {
  ports: Port[]
  killedPids: Set<number>
}

function seedMockPorts(): Port[] {
  return [
    {
      port: 3000,
      protocol: 'TCP',
      state: 'LISTEN',
      pid: 1234,
      process_name: 'node',
      parent_process: null,
      local_address: '0.0.0.0:3000',
      foreign_address: null,
      started_at: new Date().toISOString(),
      service_tag: null,
      cmdline_preview: 'node dev',
      username: null,
      cwd: null,
    },
  ]
}

function getMockStore(): MockStore {
  const g = globalThis as typeof globalThis & { __portmanMock?: MockStore }
  if (!g.__portmanMock) {
    g.__portmanMock = { ports: seedMockPorts(), killedPids: new Set() }
  }
  return g.__portmanMock
}

function visibleMockPorts(): Port[] {
  const store = getMockStore()
  return store.ports.filter((p) => p.pid == null || !store.killedPids.has(p.pid))
}

function removeMockPid(pid: number): Port | undefined {
  const store = getMockStore()
  const target = visibleMockPorts().find((p) => p.pid === pid)
  if (!target) return undefined
  store.killedPids.add(pid)
  store.ports = store.ports.filter((p) => p.pid !== pid)
  return target
}

export function createMockApi(): PortManagerAPI {
  return {
    getPorts: async () => {
      const ports = visibleMockPorts()
      return { ports: [...ports], count: ports.length }
    },
    killPort: async (port, opts) => {
      const target = visibleMockPorts().find((p) => p.port === port && p.pid)
      if (!target?.pid) return { success: false, error: `No process found using port ${port}` }
      if (opts?.dryRun) {
        return {
          success: true,
          dry_run: true,
          pid: target.pid,
          port,
          message: `Would terminate ${target.process_name ?? 'process'} (PID ${target.pid})`,
        }
      }
      removeMockPid(target.pid)
      return { success: true, pid: target.pid, port }
    },
    killPid: async (pid, opts) => {
      const target = visibleMockPorts().find((p) => p.pid === pid)
      if (!target) return { success: false, error: `Process ${pid} not found` }
      if (opts?.dryRun) {
        return {
          success: true,
          dry_run: true,
          pid,
          port: opts.port ?? target.port,
          message: `Would terminate ${target.process_name ?? 'process'} (PID ${pid})`,
        }
      }
      removeMockPid(pid)
      return { success: true, pid, port: opts?.port ?? target.port }
    },
  }
}

export function createTauriApi(): PortManagerAPI {
  return {
    async getPorts(filter) {
      const params: Record<string, unknown> = {}
      if (filter?.state) params.state = filter.state
      if (filter?.process) params.process = filter.process
      const result = (await rpc('get_ports', params)) as {
        ports: Port[]
        count: number
      }
      return result
    },
    async killPort(port: number, options?: { dryRun?: boolean }) {
      const params: Record<string, unknown> = { port }
      if (options?.dryRun) params.dry_run = true
      return (await rpc('kill_port', params)) as KillResult
    },
    async killPid(pid: number, options?: { dryRun?: boolean; port?: number }) {
      const params: Record<string, unknown> = { pid }
      if (options?.dryRun) params.dry_run = true
      if (options?.port !== undefined) params.port = options.port
      return (await rpc('kill_pid', params)) as KillResult
    },
  }
}

export function createPortmanApi(): PortManagerAPI {
  if (isTauriRuntime()) {
    return createTauriApi()
  }
  return createMockApi()
}
