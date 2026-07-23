// The common frame for an account page: the section heading and its one-line
// description, over whatever form the page carries. A plain server component so
// the three pages under /account stay consistent without repeating the wrapper
// classes — each is now its own route in the sidebar, but they read as one area.

export function AccountSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-2 py-16">
      <header className="mb-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </header>
      {children}
    </main>
  );
}
