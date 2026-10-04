import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Trash2, Info, ChevronDown, ChevronUp, Network, Copy, Clipboard, ExternalLink } from 'lucide-react'
import { open } from '@tauri-apps/api/shell'
import { toast } from 'sonner'
import { stablePortRowKey, type Port } from '../types'
import Badge, { stateBadgeVariant } from './Badge'
import { browserUrl, hostLabel } from '../portKinds'
import { isTauriRuntime } from '../api/portman'

interface PortTableProps {
  ports: Port[]
  onKill: (port: Port) => void
  onInfo: (port: Port) => void
  filter?: string
  /** Row keys that changed on last refresh (for highlight) */
  changedKeys?: Set<string>
  onBulkKill?: (ports: Port[]) => void
}

type SortKey = 'port' | 'state' | 'process_name' | 'pid'
type SortOrder = 'asc' | 'desc'

function PortTable({
  ports,
  onKill,
  onInfo,
  filter = '',
  changedKeys,
  onBulkKill,
}: PortTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const [sortKey, setSortKey] = useState<SortKey>('port')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortOrder('asc')
    }
  }

  const filteredPorts = ports.filter((p) => {
    if (!filter) return true
    const search = filter.toLowerCase()
    const hay =
      `${p.port} ${p.process_name ?? ''} ${p.pid ?? ''} ${p.state} ${p.local_address} ${p.cmdline_preview ?? ''} ${p.username ?? ''}`
    return hay.toLowerCase().includes(search)
  })

  const sortedPorts = [...filteredPorts].sort((a, b) => {
    let aVal: string | number = a[sortKey] ?? ''
    let bVal: string | number = b[sortKey] ?? ''

    if (typeof aVal === 'string') aVal = aVal.toLowerCase()
    if (typeof bVal === 'string') bVal = bVal.toLowerCase()

    if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1
    if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1
    return 0
  })

  const rowVirtualizer = useVirtualizer({
    count: sortedPorts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 46,
    overscan: 16,
  })

  const toggleSelection = (p: Port) => {
    const id = stablePortRowKey(p)
    const newSet = new Set(selectedRows)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedRows(newSet)
  }

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${text}`),
      (err) => toast.error(`Couldn't copy: ${String(err)}`),
    )
  }

  const openInBrowser = (url: string) => {
    const shown = url.replace(/^https?:\/\//, '')
    if (!isTauriRuntime()) {
      window.open(url, '_blank', 'noopener')
      toast.success(`Opening ${shown} in your browser`)
      return
    }
    open(url).then(
      () => toast.success(`Opening ${shown} in your browser`),
      (err) => toast.error(`Couldn't open ${shown}: ${String(err)}`),
    )
  }

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <span className="sort-placeholder" />
    return sortOrder === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />
  }

  const bulkTargets = sortedPorts.filter((p) => selectedRows.has(stablePortRowKey(p)))

  const allRowsSelected =
    sortedPorts.length > 0 &&
    sortedPorts.every((p) => selectedRows.has(stablePortRowKey(p)))
  const someRowsSelected = sortedPorts.some((p) => selectedRows.has(stablePortRowKey(p)))

  useEffect(() => {
    const valid = new Set(ports.map(stablePortRowKey))
    setSelectedRows((prev) => {
      const next = new Set([...prev].filter((k) => valid.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [ports])

  useEffect(() => {
    const el = selectAllRef.current
    if (!el) return
    el.indeterminate = someRowsSelected && !allRowsSelected
  }, [someRowsSelected, allRowsSelected, sortedPorts.length])

  return (
    <div className="port-table-container">
      <div className="port-table-grid-header">
        <div className="checkbox-col">
          <input
            ref={selectAllRef}
            type="checkbox"
            aria-label="Select all ports"
            aria-checked={
              allRowsSelected ? true : someRowsSelected ? 'mixed' : false
            }
            checked={allRowsSelected}
            onChange={(e) => {
              if (e.target.checked) {
                setSelectedRows(new Set(sortedPorts.map(stablePortRowKey)))
              } else {
                setSelectedRows(new Set())
              }
            }}
          />
        </div>
        <button type="button" className="port-th sortable no-drag" onClick={() => handleSort('port')}>
          Port <SortIcon column="port" />
        </button>
        <button type="button" className="port-th sortable no-drag" onClick={() => handleSort('process_name')}>
          Process <SortIcon column="process_name" />
        </button>
        <button type="button" className="port-th sortable no-drag" onClick={() => handleSort('state')}>
          State <SortIcon column="state" />
        </button>
        <button type="button" className="port-th sortable no-drag" onClick={() => handleSort('pid')}>
          PID <SortIcon column="pid" />
        </button>
        <span className="port-th">Service</span>
        <span className="port-th" title="Who can connect: localhost (this Mac only), all (any network), or one address">
          Host
        </span>
        <span className="port-th actions-th" aria-label="Actions" />
      </div>

      {onBulkKill && bulkTargets.length > 0 && (
        <div className="port-bulk-bar no-drag">
          <span>{bulkTargets.length} selected</span>
          <button
            type="button"
            className="btn danger btn-sm no-drag"
            onClick={() => onBulkKill(bulkTargets)}
          >
            Kill selected
          </button>
        </div>
      )}

      <div ref={parentRef} className="port-table-scroll" tabIndex={0}>
        <div
          className="port-table-virtual-inner"
          style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
        >
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const port = sortedPorts[vi.index]
            const rk = stablePortRowKey(port)
            const dirty = changedKeys?.has(rk)
            const url = browserUrl(port)
            return (
              <div
                key={rk}
                className={`port-table-grid-row ${vi.index % 2 === 0 ? 'even' : 'odd'} ${dirty ? 'row-updated' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <div className="checkbox-col">
                  <input
                    type="checkbox"
                    aria-label={`Select port ${port.port}`}
                    checked={selectedRows.has(rk)}
                    onChange={() => toggleSelection(port)}
                  />
                </div>
                <span className="font-mono port-number">
                  {port.port}
                  {port.protocol.toUpperCase() !== 'TCP' && (
                    <span className="protocol-tag">{port.protocol}</span>
                  )}
                </span>
                <span className="process-name" title={port.cmdline_preview ?? undefined}>
                  {port.process_name ?? 'Unknown'}
                  {port.container_hint && (
                    <span className="container-hint"> {port.container_hint}</span>
                  )}
                </span>
                <span>
                  <Badge variant={stateBadgeVariant(port.state)}>{port.state}</Badge>
                </span>
                <span className="font-mono muted-cell">{port.pid ?? '-'}</span>
                <span>
                  {port.service_tag && (
                    <span className="service-tag">{port.service_tag}</span>
                  )}
                </span>
                <span className="font-mono address muted-cell" title={port.local_address}>
                  {hostLabel(port.local_address)}
                </span>
                <div className="actions">
                  <button
                    type="button"
                    className="btn-icon info secondary-action no-drag"
                    onClick={() => copyText(port.local_address)}
                    title="Copy address"
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon info secondary-action no-drag"
                    onClick={() => port.pid && copyText(String(port.pid))}
                    title="Copy PID"
                    disabled={!port.pid}
                  >
                    <Clipboard size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon info secondary-action no-drag"
                    onClick={() => onInfo(port)}
                    title="Info"
                  >
                    <Info size={16} />
                  </button>
                  {url && (
                    <button
                      type="button"
                      className="btn-icon info no-drag"
                      onClick={() => openInBrowser(url)}
                      title={`Open ${url.replace(/^https?:\/\//, '')} in the browser`}
                    >
                      <ExternalLink size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-icon danger no-drag"
                    onClick={() => onKill(port)}
                    title="Kill"
                    disabled={!port.pid}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {sortedPorts.length === 0 && (
        <div className="empty-state">
          <Network size={48} className="empty-icon" />
          <p>No ports found</p>
          {filter && <p className="empty-hint">Try adjusting your search</p>}
        </div>
      )}
    </div>
  )
}

export default PortTable
