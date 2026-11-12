import { useApp } from '../app/context.ts'

export function SignupBanner() {
  const { audience, signedIn, flags } = useApp()
  // Sign-in buttons only matter once our JS runs: not in crawler documents.
  if (audience !== 'person' || signedIn || !flags.signup_banner) return null
  return (
    <aside className="banner">
      Don't miss what's happening. <button type="button">Sign up</button>
    </aside>
  )
}
