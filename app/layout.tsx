import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

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

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions/search", label: "Transactions" },
  { href: "/accounts", label: "Accounts" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-current/10">
          <nav
            className="mx-auto flex max-w-5xl items-center gap-6 p-4 text-sm"
            aria-label="Global"
          >
            <Link href="/" className="font-semibold">
              Money
            </Link>
            <ul className="flex items-center gap-4">
              {navItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="opacity-60 transition-opacity hover:opacity-100"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
