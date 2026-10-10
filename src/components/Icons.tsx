import type { ReactNode, SVGProps } from 'react'

// Same stroke style as agentic-browser's icons.
function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconClose = () => (
  <Svg width="12" height="12">
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
)
export const IconFolder = () => (
  <Svg>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)
export const IconSave = () => (
  <Svg>
    <path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M7 3v5h8V3M7 21v-7h10v7" />
  </Svg>
)
export const IconSaveAs = () => (
  <Svg>
    <path d="M12 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v4" />
    <path d="M7 3v5h8V3M16 19h6M19 16v6" />
  </Svg>
)
export const IconUndo = () => (
  <Svg>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
)
export const IconRedo = () => (
  <Svg>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
)
export const IconRowInsert = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="6" rx="1.5" />
    <path d="M12 14v6M9 17h6" />
  </Svg>
)
export const IconTrash = () => (
  <Svg>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Svg>
)
export const IconTable = () => (
  <Svg width="14" height="14">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M9 10v10" />
  </Svg>
)
// Copied from agentic-browser's icon set.
export const IconChevronDown = () => (
  <Svg>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)
export const IconChevronUp = () => (
  <Svg width="14" height="14">
    <path d="M18 15l-6-6-6 6" />
  </Svg>
)
export const IconCheck = () => (
  <Svg>
    <path d="M5 12l5 5 9-10" />
  </Svg>
)
export const IconSearch = () => (
  <Svg>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
)
export const IconMore = () => (
  <Svg>
    <circle cx="12" cy="5" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="19" r="1.2" fill="currentColor" />
  </Svg>
)
export const IconGoTo = () => (
  <Svg>
    <path d="M4 12h12M12 7l5 5-5 5M20 5v14" />
  </Svg>
)
/** File-type icons for the start page and tabs. */
export const IconSheet = ({ size = 16 }: { size?: number }) => (
  <Svg width={size} height={size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18" />
  </Svg>
)
export const IconCsv = ({ size = 16 }: { size?: number }) => (
  <Svg width={size} height={size}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </Svg>
)
export const IconBraces = ({ size = 16 }: { size?: number }) => (
  <Svg width={size} height={size}>
    <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
  </Svg>
)
export const IconFilter = () => (
  <Svg>
    <path d="M4 5h16l-6 7.5V18l-4 2v-7.5z" />
  </Svg>
)
export const IconCommand = () => (
  <Svg>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
  </Svg>
)
