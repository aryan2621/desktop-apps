import { Network, Settings } from 'lucide-react'

interface SidebarProps {
  activePage: string
  onNavigate: (page: string) => void
}

const navItems = [
  { id: 'ports', label: 'Ports', icon: Network },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function Sidebar({ activePage, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activePage === item.id
          
          return (
            <button
              type="button"
              key={item.id}
              className={`nav-item no-drag ${isActive ? 'active' : ''}`}
              aria-label={item.label}
              onClick={() => onNavigate(item.id)}
            >
              <Icon className="nav-icon" size={20} />
              <span className="nav-label">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <span className="version">v1.0.0</span>
      </div>
    </aside>
  )
}

export default Sidebar
