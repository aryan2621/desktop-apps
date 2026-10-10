import { useEffect, useMemo, useState } from 'react'
import type { Theme } from '@glideapps/glide-data-grid'
import { useSettings } from './settings'

/** Builds the grid theme from the app's CSS tokens so light/dark stay in sync. */
function readTheme(): Partial<Theme> {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    accentColor: v('--accent'),
    accentFg: v('--accent-text'),
    accentLight: v('--accent-soft'),
    textDark: v('--text'),
    textMedium: v('--text-muted'),
    textLight: v('--text-muted'),
    textHeader: v('--text'),
    textHeaderSelected: v('--accent-text'),
    textBubble: v('--text'),
    bgIconHeader: v('--text-muted'),
    fgIconHeader: v('--bg'),
    bgCell: v('--bg'),
    bgCellMedium: v('--bg-sunken'),
    bgHeader: v('--bg-sunken'),
    bgHeaderHasFocus: v('--bg-hover'),
    bgHeaderHovered: v('--bg-hover'),
    bgBubble: v('--bg-sunken'),
    bgBubbleSelected: v('--bg-elev'),
    bgSearchResult: v('--accent-soft'),
    borderColor: v('--border'),
    horizontalBorderColor: v('--border'),
    drilldownBorder: v('--border-strong'),
    linkColor: v('--accent'),
    cellHorizontalPadding: 10,
    cellVerticalPadding: 4,
    headerFontStyle: '600 12px',
    baseFontStyle: '13px',
    markerFontStyle: '11px',
    editorFontSize: '13px',
    // Canvas font strings can't hold the token's line breaks.
    fontFamily: v('--font').replace(/\s+/g, ' '),
  }
}

/** Backgrounds for the hovered row and for shaded (striped) rows. */
export interface RowColors {
  hover: string
  stripe: string
}

export function useGridTheme(): { theme: Partial<Theme>; rows: RowColors } {
  // Re-read the tokens when the theme setting or the OS appearance changes.
  const { theme } = useSettings()
  const [osChange, setOsChange] = useState(0)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setOsChange((n) => n + 1)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    const rows = { hover: css.getPropertyValue('--row-hover').trim(), stripe: css.getPropertyValue('--row-stripe').trim() }
    return { theme: readTheme(), rows }
  }, [theme, osChange])
}
