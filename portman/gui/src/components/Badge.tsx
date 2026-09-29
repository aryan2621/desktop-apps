interface BadgeProps {
  children: React.ReactNode
  variant?: BadgeVariant
  pulse?: boolean
}

export type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info'

export function stateBadgeVariant(state: string): BadgeVariant {
  switch (state.toUpperCase()) {
    case 'LISTEN':
      return 'success'
    case 'ESTABLISHED':
      return 'info'
    case 'TIME_WAIT':
      return 'warning'
    case 'CLOSE_WAIT':
      return 'danger'
    default:
      return 'default'
  }
}

function Badge({ children, variant = 'default', pulse = false }: BadgeProps) {
  return (
    <span className={`badge ${variant}${pulse ? ' pulse' : ''}`}>
      {children}
    </span>
  )
}

export default Badge
