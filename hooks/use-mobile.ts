import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

// Created on first use rather than at module load: this module is imported into
// a server-rendered tree, where `window` does not exist. One MediaQueryList is
// enough no matter how many components call the hook — each subscriber adds its
// own listener to it.
let mql: MediaQueryList | undefined
function mediaQuery() {
  return (mql ??= window.matchMedia(MOBILE_QUERY))
}

// Kept at module scope so the identity is stable. useSyncExternalStore tears
// down and re-subscribes whenever `subscribe` changes, which a function defined
// in the hook body would do on every render.
function subscribe(onStoreChange: () => void) {
  const query = mediaQuery()
  query.addEventListener("change", onStoreChange)
  return () => query.removeEventListener("change", onStoreChange)
}

function getSnapshot() {
  return mediaQuery().matches
}

// The server has no viewport, so it renders the desktop layout. That is what the
// previous effect-based version did too — its state began `undefined` and read
// as false — and useSyncExternalStore re-checks the real viewport immediately
// after hydration, re-rendering if it disagrees.
function getServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
