import type { MetadataRoute } from "next";

// The web app manifest (served at /manifest.webmanifest, linked automatically by
// Next from this file convention). Icons are the favicon_io export's Android
// sizes, kept in public/. Names carry the app's own, not favicon_io's blanks.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Money",
    short_name: "Money",
    icons: [
      {
        src: "/android-chrome-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/android-chrome-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
    theme_color: "#ffffff",
    background_color: "#ffffff",
    display: "standalone",
  };
}
