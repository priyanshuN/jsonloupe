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

1. In Cloudflare DNS, change the `jsonloupe.dev` A records and `www` CNAME from
   **DNS only** to **Proxied**. Keep GitHub's current record values.
2. Confirm SSL/TLS mode is **Full (strict)** and that HTTPS works before adding
   HSTS.
3. Create a response-header transform rule for hostnames `jsonloupe.dev` and
   `www.jsonloupe.dev`, on all paths, setting the five non-CSP headers above.
4. Create a second response-header transform rule for the HTML paths `/`,
   `/index.html`, `/json-to-excel.html`, `/spec.html`, and `/styleguide.html`,
   setting `Content-Security-Policy` to the policy above. Limiting CSP to HTML
   leaves the capability-stripped Run worker free to compile only the script a
   user explicitly enters, while the document still restricts worker creation
   to same-origin or `blob:` URLs.
5. Do not enable HSTS `includeSubDomains` or preload without separately checking
   every subdomain; neither is required for this project criterion.

Cloudflare applies response transforms only to proxied traffic. If the records
are returned to DNS-only mode, the headers disappear and HSTS can make the site
unreachable, so disable or expire HSTS before such a rollback.

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
