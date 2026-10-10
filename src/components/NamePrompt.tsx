import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  initial: string
  at: { x: number; y: number }
  onSubmit: (name: string) => void
  onClose: () => void
}

/** A small popover with one text field, e.g. for naming a column. Enter saves, Escape cancels. */
export function NamePrompt({ title, initial, at, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    input.current?.select()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const submit = () => {
    const name = value.trim()
    if (name) onSubmit(name)
  }

  return (
    <div
      ref={root}
      className="popover"
      role="dialog"
      aria-label={title}
      style={{ top: at.y, left: Math.min(at.x, window.innerWidth - 300) }}
    >
      <label className="popover-title" htmlFor="name-prompt">
        {title}
      </label>
      <input
        id="name-prompt"
        ref={input}
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <div className="popover-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!value.trim()} onClick={submit}>
          Save
        </button>
      </div>
    </div>
  )
}
