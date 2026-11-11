import type { ReactNode } from 'react'
import { useApp } from '../app/context.ts'

// Plain links preload code + data on intent: hover or keyboard focus.
export function Link({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const { navigate, preload, audience } = useApp()
  if (audience === 'crawler') return <a href={href} className={className}>{children}</a>
  return (
    <a
      href={href}
      className={className}
      onMouseEnter={() => preload(href)}
      onFocus={() => preload(href)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(href)
      }}
    >
      {children}
    </a>
  )
}
