# Generic REST Connector — SSRF Security (Phase 6B)

`src/connectors/core/ssrf.js`. Every outbound Generic REST request — actions AND health checks,
no exceptions (Part 20/48) — goes through this one module. Nothing else in the codebase issues
a Generic REST connector's outbound HTTP request.

## The real mitigation, not just a comment

`safeFetch()` does **not** use the global `fetch`. It:
1. Validates the URL (scheme, no embedded credentials, hostname not an obviously-blocked
   literal, optional allowlist boundary-matched).
2. Resolves the hostname via `node:dns/promises` **itself** and validates **every** returned
   address against the full private/reserved/metadata IPv4 and IPv6 ranges.
3. Connects directly to the validated IP via `node:http`/`node:https`'s `request()` — passing
   the real `Host` header and TLS `servername` (SNI) so virtual hosting and certificate
   validation still work correctly — **never** re-resolving the hostname at connect time.

Step 3 is the actual DNS-rebinding mitigation: since the real socket connects to the IP this
module itself validated, a hostname that changes its DNS answer between validation and
connection cannot redirect the request — because the (unchanged) global `fetch` was never
given the chance to re-resolve it independently.

## Honest residual limitation (Part 27)

If a single hostname resolves to **multiple** addresses and only some are private, every
address is validated and the **first public one** is used for the connection. A provider that
returns a deliberately-mixed address set specifically to race within one connection attempt's
own resolution window is not defended beyond DNS/IP validation — that is an OS/network-level
concern outside what a pure-JS module can close. This is not "perfect DNS pinning" and is not
claimed to be.

## Blocked, exactly per the required matrix (Part 80)

- Schemes: `file:`, `ftp:`, `gopher:`, `data:`, `javascript:`, `ws:`, `wss:`, `unix:` — always.
  `http:` — blocked unless `allowHttp:true` is explicitly passed (never a tenant-facing switch).
- Hostnames: `localhost` and `localhost.` (trailing-dot bypass), `metadata.google.internal`.
- IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (covers
  `169.254.169.254`), `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4`, `240.0.0.0/4`.
- IPv6: `::1`, `::` (unspecified), `fc00::/7` (unique local), `fe80::/10` (link-local), and any
  IPv4-mapped address (`::ffff:a.b.c.d`) whose embedded IPv4 is itself private.
- URLs with embedded credentials (`https://user:pass@host`) — always rejected (Part 29);
  authentication belongs in the Credentials Vault only.
- `allowedHosts` uses an **exact hostname match**, never `endsWith`/`includes` — `vendor.com`
  never matches `evilvendor.com` or `api.vendor.com.evil.com` (Part 31).

## Redirects (Part 28/88)

Never handed to a library's automatic-follow behavior. Each redirect response is intercepted,
the `Location` header resolved and **re-validated from scratch** (scheme, hostname, DNS, every
address) before being followed. Bounded to 3 hops by default (`maxRedirects`); a `303` redirect
correctly downgrades the method to `GET` per HTTP semantics.

## Limits (Part 35-37)

- Timeout: caller-configurable, hard-clamped to a 30-second platform ceiling regardless of what
  a manifest/action requests.
- Response size: streamed and counted as it arrives; aborted the instant it exceeds the
  configured ceiling (never buffered unbounded first).
- Request body size: checked before the request is even sent.

## Testability (Part 82/102)

`resolveAndValidateHost` and `safeFetch` both accept injectable `resolver`/`transport`
functions. Tests (`tests/connector-ssrf.test.js`) exercise the full pipeline — including
redirect-to-private blocking, oversized-response rejection, and the complete IPv4/IPv6 matrix —
with zero real DNS lookups or real sockets. Production code paths never pass either override;
the real `dns.lookup` and `node:http`/`https` implementations always run live.
