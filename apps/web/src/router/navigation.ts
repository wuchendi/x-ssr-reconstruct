// Navigations resolve asynchronously (route chunk + preload). If the user
// clicks again, or goes back twice, an older one can finish after a newer
// one; it must not commit over it. begin() returns "am I still the latest?".
export function createNavigationGate() {
  let latest = 0
  return {
    begin() {
      const id = ++latest
      return () => id === latest
    },
  }
}
