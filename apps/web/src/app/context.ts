import { createContext, use } from 'react'
import type { Audience } from '../router/types.ts'

export type AppCtx = {
  audience: Audience
  signedIn: boolean
  flags: Record<string, boolean>
  navigate: (href: string) => void
  preload: (href: string) => void
}

export const AppContext = createContext<AppCtx | null>(null)
export const useApp = () => use(AppContext)!
