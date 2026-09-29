import { useState, useEffect, useMemo } from 'react'
import {
  Search,
  RefreshCw,
  Radio,
  Link2,
  Clock,
  AlertCircle,
  Zap,
  LayoutGrid,
} from 'lucide-react'
import PortTable from '../components/PortTable'
import Modal from '../components/Modal'
import Badge, { stateBadgeVariant } from '../components/Badge'
import { stablePortRowKey, type KillResult, type Port } from '../types'

interface PortsProps {
  ports: Port[]
  loading?: boolean
  isLive: boolean
  onToggleLive: () => void
  onKillPid: (pid: number, options?: { dryRun?: boolean; port?: number }) => Promise<KillResult>
  onRefresh: () => void
  changedKeys?: Set<string>
}

type FilterState = 'ALL' | 'LISTEN' | 'ESTABLISHED' | 'TIME_WAIT' | 'CLOSE_WAIT'

const BULK_CONFIRM_TEXT = 'KILL'

function Ports({
  ports,
  loading,
  isLive,
  onToggleLive,
  onKillPid,
  onRefresh,
  changedKeys,
}: PortsProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState<FilterState>('ALL')

  const [infoPort, setInfoPort] = useState<Port | null>(null)
  const [killConfirmPort, setKillConfirmPort] = useState<Port | null>(null)
  const [killTypeConfirm, setKillTypeConfirm] = useState('')
  const [bulkTargets, setBulkTargets] = useState<Port[] | null>(null)
  const [bulkTypeConfirm, setBulkTypeConfirm] = useState('')
  const [killError, setKillError] = useState<string | null>(null)
  const [killNotice, setKillNotice] = useState<string | null>(null)
  const [killing, setKilling] = useState(false)

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchQuery), 200)
    return () => clearTimeout(t)
  }, [searchQuery])

  useEffect(() => {
    if (!killNotice) return
    const t = window.setTimeout(() => setKillNotice(null), 4000)
    return () => clearTimeout(t)
  }, [killNotice])

  const filteredPorts = useMemo(() => {
    return ports.filter((p) => {
      if (activeFilter === 'ALL') return true
      return p.state.toUpperCase() === activeFilter
    })
  }, [ports, activeFilter])

  const portStats = useMemo(() => {
    let listening = 0
    let established = 0
    for (const p of filteredPorts) {
      const s = p.state.toUpperCase()
      if (s === 'LISTEN') listening++
      if (s === 'ESTABLISHED') established++
    }
    return {
      visible: filteredPorts.length,
      listening,
      established,
      totalAllStates: ports.length,
    }
  }, [filteredPorts, ports.length])

  const filters: { key: FilterState; label: string; icon: typeof Radio }[] = [
    { key: 'ALL', label: 'All', icon: Zap },
    { key: 'LISTEN', label: 'Listening', icon: Radio },
    { key: 'ESTABLISHED', label: 'Established', icon: Link2 },
    { key: 'TIME_WAIT', label: 'Time-wait', icon: Clock },
    { key: 'CLOSE_WAIT', label: 'Close-wait', icon: AlertCircle },
  ]

  const handleKill = (port: Port) => {
    setKillError(null)
    setKillTypeConfirm('')
    setKilling(false)
    setKillConfirmPort(port)
  }

  const confirmTextMatches = killConfirmPort
    ? killTypeConfirm.trim() === String(killConfirmPort.port)
    : false
  const bulkConfirmMatches = bulkTypeConfirm.trim() === BULK_CONFIRM_TEXT

  const confirmKill = async () => {
    if (!killConfirmPort || killing) return
    if (!confirmTextMatches) {
      setKillError(`Type ${killConfirmPort.port} to confirm`)
      return
    }
    if (!killConfirmPort.pid) {
      setKillError('No PID for this connection')
      return
    }

    setKilling(true)
    setKillError(null)
    const result = await onKillPid(killConfirmPort.pid, { port: killConfirmPort.port })
    setKilling(false)
    if (!result.success) {
      setKillError(result.error || 'Failed')
      return
    }
    setKillNotice(
      result.message ||
        `Terminated ${killConfirmPort.process_name || 'process'} (PID ${killConfirmPort.pid})`,
    )
    setKillConfirmPort(null)
    setKillTypeConfirm('')
    setKillError(null)
  }

  const confirmBulkKill = async () => {
    if (!bulkTargets?.length || killing) return
    if (!bulkConfirmMatches) {
      setKillError(`Type ${BULK_CONFIRM_TEXT} to confirm`)
      return
    }
    setKilling(true)
    setKillError(null)
    const seenPids = new Set<number>()
    for (const p of bulkTargets) {
      if (!p.pid || seenPids.has(p.pid)) continue
      seenPids.add(p.pid)
      const result = await onKillPid(p.pid, { port: p.port })
      if (!result.success) {
        setKilling(false)
        setKillError(result.error || `Failed on port ${p.port}`)
        return
      }
    }
    setKilling(false)
    setKillNotice(`Terminated ${seenPids.size} process(es).`)
    setBulkTargets(null)
    setBulkTypeConfirm('')
    setKillError(null)
  }

  return (
    <div className="page ports-page">
      <header className="page-header">
        <div>
          <h1>Ports</h1>
          <p className="subtitle">
            Live socket inventory — filter, inspect, and reclaim ports safely.
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`live-toggle no-drag ${isLive ? 'active' : ''}`}
            onClick={onToggleLive}
          >
            <span className={`pulse-dot ${isLive ? 'active' : ''}`} />
            {isLive ? 'Live' : 'Paused'}
          </button>
          <button
            type="button"
            className="btn-icon refresh no-drag"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {killNotice && <div className="page-banner">{killNotice}</div>}
      <div className="ports-stats" aria-label="Port summary">
        <div className="stat-chip stat-accent">
          <LayoutGrid size={18} className="stat-icon" aria-hidden />
          <div className="stat-meta">
            <span className="stat-label">Showing</span>
            <strong>{portStats.visible}</strong>
          </div>
        </div>
        <div className="stat-chip">
          <Radio size={18} className="stat-icon" aria-hidden />
          <div className="stat-meta">
            <span className="stat-label">Listening</span>
            <strong>{portStats.listening}</strong>
          </div>
        </div>
        <div className="stat-chip">
          <Link2 size={18} className="stat-icon" aria-hidden />
          <div className="stat-meta">
            <span className="stat-label">Established</span>
            <strong>{portStats.established}</strong>
          </div>
        </div>
        {activeFilter !== 'ALL' && (
          <div className="stat-chip">
            <Zap size={18} className="stat-icon" aria-hidden />
            <div className="stat-meta">
              <span className="stat-label">Total (any state)</span>
              <strong>{portStats.totalAllStates}</strong>
            </div>
          </div>
        )}
      </div>

      <div className="search-bar">
        <Search size={18} className="search-icon" />
        <input
          type="text"
          placeholder="Search port, process, PID, cmdline..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
        />
      </div>

      <div className="filter-preset-row">
        <div className="filter-pills">
          {filters.map(({ key, label, icon: Icon }) => (
            <button
              type="button"
              key={key}
              className={`filter-pill no-drag ${activeFilter === key ? 'active' : ''}`}
              onClick={() => setActiveFilter(key)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <PortTable
        ports={filteredPorts}
        filter={debouncedSearch}
        changedKeys={changedKeys}
        onBulkKill={(targets) => {
          const withPid = targets.filter((t) => t.pid)
          setKillError(null)
          setKilling(false)
          if (withPid.length === 1) {
            handleKill(withPid[0])
            return
          }
          setBulkTypeConfirm('')
          setBulkTargets(withPid)
        }}
        onKill={(port) => handleKill(port)}
        onInfo={(port) => setInfoPort(port)}
      />

      <Modal
        isOpen={!!infoPort}
        onClose={() => setInfoPort(null)}
        title={
          infoPort
            ? `${infoPort.process_name || 'Process'} — PID ${infoPort.pid ?? '?'}`
            : 'Port Info'
        }
        size="medium"
      >
        {infoPort && (
          <div className="port-info">
            {infoPort.service_tag && (
              <div className="info-row">
                <span className="label">Service</span>
                <span className="value service-tag">{infoPort.service_tag}</span>
              </div>
            )}
            <div className="info-row">
              <span className="label">Port</span>
              <span className="value font-mono">{infoPort.port}</span>
            </div>
            <div className="info-row">
              <span className="label">Protocol</span>
              <span className="value">{infoPort.protocol}</span>
            </div>
            <div className="info-row">
              <span className="label">State</span>
              <span className="value">
                <Badge variant={stateBadgeVariant(infoPort.state)}>{infoPort.state}</Badge>
              </span>
            </div>
            <div className="info-row">
              <span className="label">PID</span>
              <span className="value font-mono">{infoPort.pid ?? '-'}</span>
            </div>
            <div className="info-row">
              <span className="label">Process</span>
              <span className="value">{infoPort.process_name ?? 'Unknown'}</span>
            </div>
            {infoPort.username && (
              <div className="info-row">
                <span className="label">User</span>
                <span className="value">{infoPort.username}</span>
              </div>
            )}
            {infoPort.cwd && (
              <div className="info-row stacked-row">
                <span className="label">Working directory</span>
                <span className="value font-mono cmdline-preview">{infoPort.cwd}</span>
              </div>
            )}
            {infoPort.cmdline_preview && (
              <div className="info-row stacked-row">
                <span className="label">Command</span>
                <span className="value cmdline-preview">{infoPort.cmdline_preview}</span>
              </div>
            )}
            {infoPort.container_hint && (
              <div className="info-row">
                <span className="label">Environment</span>
                <span className="value">{infoPort.container_hint}</span>
              </div>
            )}
            <div className="info-row">
              <span className="label">Local Address</span>
              <span className="value font-mono">{infoPort.local_address}</span>
            </div>
            {infoPort.foreign_address && (
              <div className="info-row">
                <span className="label">Foreign Address</span>
                <span className="value font-mono">{infoPort.foreign_address}</span>
              </div>
            )}
            {infoPort.started_at && (
              <div className="info-row">
                <span className="label">Started</span>
                <span className="value">{new Date(infoPort.started_at).toLocaleString()}</span>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!killConfirmPort}
        onClose={() => {
          if (killing) return
          setKillConfirmPort(null)
          setKillTypeConfirm('')
          setKillError(null)
        }}
        title={
          killConfirmPort
            ? `${killConfirmPort.process_name || 'Process'} (PID ${killConfirmPort.pid})`
            : 'Confirm Kill'
        }
        size="small"
      >
        {killConfirmPort && (
          <form
            className="kill-confirm"
            onSubmit={(e) => {
              e.preventDefault()
              void confirmKill()
            }}
          >
            <p className="confirm-text">
              Kill <strong>{killConfirmPort.process_name || 'Unknown'}</strong> (PID{' '}
              {killConfirmPort.pid}) using port {killConfirmPort.port}?
            </p>

            <p className="confirm-port-hint">
              Type <strong>{killConfirmPort.port}</strong> to confirm:
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className={`confirm-port-input ${killTypeConfirm && !confirmTextMatches ? 'invalid' : ''}`}
              placeholder={String(killConfirmPort.port)}
              value={killTypeConfirm}
              onChange={(e) => setKillTypeConfirm(e.target.value.replace(/\s/g, ''))}
              aria-invalid={killTypeConfirm !== '' && !confirmTextMatches}
            />

            {killError && <div className="error-message">{killError}</div>}

            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost no-drag"
                disabled={killing}
                onClick={() => {
                  setKillConfirmPort(null)
                  setKillTypeConfirm('')
                  setKillError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn danger no-drag"
                disabled={!confirmTextMatches || killing}
              >
                {killing ? 'Killing…' : 'Kill Process'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={!!bulkTargets && bulkTargets.length > 0}
        onClose={() => {
          if (killing) return
          setBulkTargets(null)
          setBulkTypeConfirm('')
          setKillError(null)
        }}
        title="Kill selected processes"
        size="medium"
      >
        {bulkTargets && bulkTargets.length > 0 && (
          <form
            className="kill-confirm"
            onSubmit={(e) => {
              e.preventDefault()
              void confirmBulkKill()
            }}
          >
            <p className="confirm-text">
              Terminate <strong>{bulkTargets.length}</strong> process(es):
            </p>
            <ul className="bulk-kill-list">
              {bulkTargets.map((p) => (
                <li key={stablePortRowKey(p)}>
                  <span className="font-mono">{p.port}</span> — {p.process_name ?? '?'} (PID{' '}
                  {p.pid})
                </li>
              ))}
            </ul>
            <p className="confirm-port-hint">
              Type <strong>{BULK_CONFIRM_TEXT}</strong> to confirm:
            </p>
            <input
              type="text"
              autoComplete="off"
              className={`confirm-port-input ${bulkTypeConfirm && !bulkConfirmMatches ? 'invalid' : ''}`}
              placeholder={BULK_CONFIRM_TEXT}
              value={bulkTypeConfirm}
              onChange={(e) => setBulkTypeConfirm(e.target.value.replace(/\s/g, ''))}
              aria-invalid={bulkTypeConfirm !== '' && !bulkConfirmMatches}
            />
            {killError && <div className="error-message">{killError}</div>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost no-drag"
                disabled={killing}
                onClick={() => {
                  setBulkTargets(null)
                  setBulkTypeConfirm('')
                  setKillError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn danger no-drag"
                disabled={!bulkConfirmMatches || killing}
              >
                {killing ? 'Killing…' : 'Kill all'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}

export default Ports
