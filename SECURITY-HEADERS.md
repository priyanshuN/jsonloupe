# Public-site security headers

The OpenSSF Gold `hardened_site` criterion requires the project site to return
non-permissive CSP, HSTS, `X-Content-Type-Options`, and `X-Frame-Options`
headers. A CSP `<meta>` element protects each shipped HTML entry immediately,
and the packaged loopback server sends every applicable header, but only an
HTTP edge can add all four to `https://jsonloupe.dev`.

## Policy

HTML responses use this CSP:

```text
default-src 'none'; base-uri 'none'; connect-src 'self' https://api.anthropic.com https://openrouter.ai; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:
```

`style-src 'unsafe-inline'` is limited to CSS. The script policy does not allow
inline code or `eval`; the deliberate Run evaluator lives in its own external
worker. Pre-paint, converter-landing, and styleguide behavior are external
scripts so the page policy can remain strict.

Every HTTPS response also uses:

```text
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), geolocation=(), microphone=()
```

## Cloudflare edge configuration

GitHub Pages remains the origin. The `jsonloupe.dev` zone already delegates DNS
to Cloudflare, so the least disruptive deployment is to proxy the existing
apex A records and `www` CNAME, then add response-header transform rules. This
is account configuration, not something a repository workflow can truthfully
claim to have deployed.

1. In Cloudflare DNS, change the `jsonloupe.dev` A **and AAAA** records and the
   `www` CNAME from **DNS only** to **Proxied**. Keep GitHub's current record
   values, and leave the MX and TXT records DNS-only. The AAAA records are easy
   to miss and matter as much as the A records: left DNS-only they still resolve
   to GitHub, so every IPv6 visitor bypasses the edge and receives none of these
   headers — and a verification run over IPv4 will not catch it. After the
   change, `dig AAAA jsonloupe.dev` must return Cloudflare space (`2606:4700::/32`),
   not GitHub's `2606:50c0::/32`.
2. Set SSL/TLS mode to **Full**, not **Full (strict)**, and confirm that HTTPS
   works before adding HSTS. GitHub Pages does not keep its certificate renewed
   while these records are proxied, so strict origin validation ends in an
   outage (see below). Select **Full** explicitly: a zone left on **Automatic
   SSL/TLS** can move to **Full (strict)** on its own next scan.
3. Create a response-header transform rule for hostnames `jsonloupe.dev` and
   `www.jsonloupe.dev`, on all paths, setting the five non-CSP headers above.
4. Create a second response-header transform rule for the HTML paths `/`,
   `/index.html`, `/json-to-excel.html`, `/json-to-csv.html`, `/json-editor.html`,
   `/json-diff.html`, `/large-json-viewer.html`, `/jsonl-viewer.html`,
   `/spec.html`, and `/styleguide.html`,
   setting `Content-Security-Policy` to the policy above. The page policy is
   not applied to the Run worker, which must compile the script a user
   explicitly enters, while the document still restricts worker creation to
   same-origin or `blob:` URLs.
5. Create a third response-header transform rule for paths matching
   `/assets/run-sandbox-*.js`, setting `Content-Security-Policy` to
   `default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'none'`.
   A dedicated worker takes its policy from its own response, not the page's.
   With no policy, a pasted script's dynamic `import()` could carry the
   document to any host; `import()` is syntax, so the sandbox cannot strip it
   the way it strips `fetch`. This policy allows the eval Run exists for and
   nothing off-origin. The packaged loopback server sends the same header.
6. Do not enable HSTS `includeSubDomains` or preload without separately checking
   every subdomain; neither is required for this project criterion.
7. Set **Minimum TLS Version** to TLS 1.2 (SSL/TLS → Edge Certificates). The
   zone default still accepts TLS 1.0 and 1.1, which browsers no longer use.

The `_github-pages-challenge-priyanshuN` TXT record verifies `jsonloupe.dev` on
the GitHub account. While the apex records point at GitHub, it stops any other
account from publishing a Pages site at the domain, so keep it, even while the
site is down or the repository is private.

Cloudflare applies response transforms only to proxied traffic. If the records
are returned to DNS-only mode, the headers disappear and HSTS can make the site
unreachable, so disable or expire HSTS before such a rollback.

Under **Full (strict)** an expired origin certificate stops being a degraded
connection and becomes a hard `526` outage, and GitHub's certificate renewal
does not keep working from behind the proxy. The Pages health API reports
`is_proxied: true` and `is_https_eligible: false` for this domain. The first
certificate, issued 2026-08-01 before the proxy went on, expired on 2026-10-30
in the state `bad_authz`, although `/.well-known/acme-challenge/` still reached
GitHub over plain HTTP. The site returned `526` until the mode moved to **Full**
on 2026-10-31.

**Full** keeps the Cloudflare-to-GitHub link encrypted but does not validate the
origin certificate, so an attacker on that path could present a forged one. The
GitHub certificate stays expired, which visitors do not see because they receive
Cloudflare's edge certificate. If the records return to DNS-only mode, visitors
receive the expired certificate until GitHub issues a new one. Moving back to
**Full (strict)** needs a valid GitHub certificate first, and the same outage
can return when that certificate expires.

## Verification

After deployment, run:

```sh
npm run check:site-headers
curl -sSI https://jsonloupe.dev/
curl -sSI https://jsonloupe.dev/json-to-excel.html
```

The automated check follows redirects, requires a one-year HSTS max age,
rejects permissive script policies, and verifies all four Gold headers. Record
the successful public URL in the Gold worksheet only after this command passes
against the live site.

`.github/workflows/site-check.yml` runs the same check every 30 minutes. If the
check fails, the workflow opens one `site-down` issue that mentions the
maintainer, which is the outage alert, and it closes that issue when the check
passes again. GitHub pauses scheduled workflows after 60 days with no repository
activity; re-enable it from the Actions tab if that happens.
