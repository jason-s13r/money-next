"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * The invite link, to copy and send.
 *
 * The origin comes from `window.location` rather than a configured base URL,
 * because the link only has to work for whoever is looking at this page: they
 * reached it on some origin, and that origin is by definition one that resolves.
 * A misconfigured `BETTER_AUTH_URL` would otherwise produce a link that copies
 * cleanly and fails silently in someone else's chat window.
 */
export function InviteLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/invite/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access needs a secure context and can be refused outright.
      // Prompting with the URL selected is a worse experience than copying, and
      // a better one than a button that does nothing.
      window.prompt("Copy this invitation link", url);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
