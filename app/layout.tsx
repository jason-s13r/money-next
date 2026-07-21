import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { CSPProvider } from "@base-ui/react/csp-provider";
import "./globals.css";
import { ThemeProvider } from "@/ui/chrome/theme-provider";

// The nav used to be rendered here, for every page. It moved to
// app/w/[workspace]/layout.tsx when the workspace moved into the URL: the nav's
// links are all workspace-relative now, and this layout also wraps /login, which
// has no workspace to link within.

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Money", template: "%s · Money" },
  description: "Personal finance dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The per-request CSP nonce, minted in proxy.ts and carried on this header.
  // Three sets of inline tags need it stamped on or a strict CSP blocks them:
  // next-themes' pre-paint theme <script> (via ThemeProvider's `nonce`), and
  // Base UI's scroll-lock <style>/<script> tags (via CSPProvider). Next stamps
  // its own scripts automatically; these third-party ones do not, so they were
  // being blocked (script-src-elem / style-src-elem) until wired up here.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      // next-themes writes the theme class here before paint; suppress the
      // hydration warning for the attribute it injects on the server/client seam.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <CSPProvider nonce={nonce}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
            nonce={nonce}
          >
            {children}
          </ThemeProvider>
        </CSPProvider>
      </body>
    </html>
  );
}
