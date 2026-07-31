import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isLocalHostname } from "../lib/server/chat/client";

/**
 * The check that keeps the prompt on this machine.
 *
 * A chat prompt here is the household's transaction history — every payee, every
 * amount, three years of it. `LLM_API` decides where that goes, and an operator
 * pointing it somewhere remote by mistake is a data leak with no error message
 * and no log line: the model answers perfectly, and the history has left.
 *
 * The cases that matter are not `127.0.0.1` and `example.com`. They are the
 * hostnames that *look* private and are not. `10.evil.com` is a domain anyone
 * can register and point anywhere, and a check that matched the private ranges
 * as a prefix — which the first version of this did — would have called it local
 * and sent the lot. Every one of those below is here because a plausible
 * implementation gets it wrong.
 */

describe("isLocalHostname", () => {
  test("loopback, in both families", () => {
    assert.equal(isLocalHostname("127.0.0.1"), true);
    assert.equal(isLocalHostname("127.1.2.3"), true, "the whole 127/8, not just .0.1");
    assert.equal(isLocalHostname("::1"), true);
    assert.equal(isLocalHostname("[::1]"), true, "as `new URL().hostname` spells it");
    assert.equal(isLocalHostname("0.0.0.0"), true);
  });

  test("the private IPv4 ranges", () => {
    assert.equal(isLocalHostname("10.0.0.5"), true);
    assert.equal(isLocalHostname("192.168.1.10"), true);
    assert.equal(isLocalHostname("169.254.1.1"), true);
    assert.equal(isLocalHostname("172.16.0.1"), true);
    assert.equal(isLocalHostname("172.31.255.254"), true);
  });

  test("the near misses either side of 172.16/12", () => {
    assert.equal(isLocalHostname("172.15.0.1"), false);
    assert.equal(isLocalHostname("172.32.0.1"), false);
  });

  test("public addresses are not local", () => {
    assert.equal(isLocalHostname("8.8.8.8"), false);
    assert.equal(isLocalHostname("1.1.1.1"), false);
    assert.equal(isLocalHostname("172.217.16.14"), false);
  });

  test("a hostname that merely starts like a private range is not one", () => {
    // The bug this test exists for. These are registrable domains; a prefix match
    // against the private ranges says local and hands over the prompt.
    assert.equal(isLocalHostname("10.evil.com"), false);
    assert.equal(isLocalHostname("192.168.attacker.net"), false);
    assert.equal(isLocalHostname("127.0.0.1.evil.com"), false);
    assert.equal(isLocalHostname("172.16.example.org"), false);
  });

  test("an octet over 255 is not an IPv4 literal, so it is judged as a name", () => {
    assert.equal(isLocalHostname("10.999.0.1"), false);
    assert.equal(isLocalHostname("999.999.999.999"), false);
  });

  test("a single-label host is local — the self-hosted LAN case", () => {
    assert.equal(isLocalHostname("localhost"), true);
    assert.equal(isLocalHostname("homelab"), true, "a machine on the LAN, by name");
    assert.equal(isLocalHostname("ollama"), true, "a compose service name");
  });

  test("the reserved local suffixes", () => {
    assert.equal(isLocalHostname("model.localhost"), true);
    assert.equal(isLocalHostname("homelab.local"), true);
    assert.equal(isLocalHostname("ollama.internal"), true);
    assert.equal(isLocalHostname("HOMELAB.LOCAL"), true, "case-insensitive");
    assert.equal(isLocalHostname("homelab.local."), true, "trailing root dot");
  });

  test("a suffix that only resembles a reserved one is not local", () => {
    assert.equal(isLocalHostname("notlocalhost.com"), false);
    assert.equal(isLocalHostname("local.example.com"), false);
    assert.equal(isLocalHostname("evil-local.com"), false);
  });

  test("a non-loopback IPv6 literal is refused rather than half-parsed", () => {
    // Deliberate: unique-local and link-local IPv6 exist, but nothing here
    // reaches the model over IPv6, and LLM_ALLOW_REMOTE is the honest answer.
    assert.equal(isLocalHostname("fd00::1"), false);
    assert.equal(isLocalHostname("2001:4860:4860::8888"), false);
  });
});
