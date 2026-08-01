// Merchants created by hand carry no logo — Akahu only supplies one for the
// merchants it recognises — so a row for a custom merchant would otherwise sit a
// logo-width to the left of every row around it. This fills that gap.
//
// A local copy of Akahu's own merchant placeholder rather than a link to
// https://cdn.akahu.nz/logos/merchants/default.png: the file is served straight
// from `public/` with no third-party request, and it cannot break the day Akahu
// moves the asset. It is a plain <img> underneath, which cannot see the `.dark`
// class next-themes toggles, so it stays a light square in dark mode — the same
// as most of the real logos it sits beside.
//
// Merchants only. Every connection arrives from Akahu with a logo, and the CDN
// has no connection-shaped default to copy (every spelling of it 403s), so the
// bank logo sites still render nothing when `logo` is null.
export const MERCHANT_LOGO_FALLBACK = "/merchant-default.png";
