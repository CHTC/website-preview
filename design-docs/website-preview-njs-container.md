# website-preview: minimal nginx + njs push container

A single nginx container that hosts static dev builds and accepts WebDAV pushes from one reusable GitHub workflow. All authorization is done inside nginx by an njs script that verifies the workflow's GitHub OIDC token. There is no second process, no session endpoint, and no stored secret.

- Push URL: `https://push.website-preview.chtc.io`
- Site URLs: `https://<label>.website-preview.chtc.io`, where `<label>` is `<pr|main>-<repo>-<org>`
- Date written: 2026-10-27

## How it works

1. The push job asks GitHub for an OIDC token with audience `push.website-preview.chtc.io`.
2. The job sends that token on **every** request (`Authorization: Bearer ...`).
3. For each `PUT`/`MKCOL`/`DELETE`, nginx runs `auth_request` against an internal njs handler (`auth.verify`).
4. The handler looks up `sha256(token + X-PR)` in a shared-memory cache.
   - **Hit:** reuse the stored result.
   - **Miss:** verify the RS256 signature against GitHub's JWKS, check the claims, run `authorize()`, and cache the result until the token's own `exp` or 10 minutes, whichever is sooner.
5. The handler then checks the method and the percent-decoded path against the label that `authorize()` produced. A `204` lets nginx's DAV module write the file.

The server derives the directory from the token's `repository_id`, never from anything the workflow sends, so one repo cannot write another repo's directory.

## DNS and TLS

One wildcard record and one wildcard certificate cover everything, including the push host:

```
*.website-preview.chtc.io.   300 IN A   <host IP>
```

- Certificate: `*.website-preview.chtc.io` (Let's Encrypt needs DNS-01 for wildcards).
- `push.website-preview.chtc.io` also matches the read host's regex, but nginx prefers an exact `server_name` over a regex, so the push block wins. Never create a site whose label is exactly `push`.
- A wildcard matches one DNS label only, so labels must not contain dots (`osg-htc.github.io` becomes `osg-htc-github-io`).

## Directory labels

The label is `<pr-number>-<repo>-<org>`, lowercased, with `.` and `/` turned into `-`.

| Event | Label example |
| --- | --- |
| PR 42 | `42-osg-htc-github-io-osg-htc` |

Both the workflow and `sites.json` must produce the same string. A mismatch fails closed with a 403 and `reason=path` in the log.

```bash
# the one rule, used by the workflow and when generating sites.json
printf '%s' "$repo-$org" | tr 'A-Z./' 'a-z--'
```

## Files

```
website-preview/
  Dockerfile
  nginx.conf
  sites.json
  njs/auth.js
  docker-entrypoint.d/05-setup.sh
```

### Dockerfile

```dockerfile
# Verified: nginx 1.31.8 + njs 1.0.2 + CA bundle. Pin by digest once you've chosen:
#   docker inspect --format '{{index .RepoDigests 0}}' nginx:latest
FROM nginx:latest

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY njs/auth.js /etc/nginx/njs/auth.js
COPY sites.json /etc/nginx/sites.json
COPY --chmod=0755 docker-entrypoint.d/05-setup.sh /docker-entrypoint.d/05-setup.sh
RUN mkdir -p /srv/sites/.tmp && chown -R nginx:nginx /srv/sites

USER nginx
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:8081/healthz || exit 1
```

### docker-entrypoint.d/05-setup.sh

The official entrypoint runs this before nginx starts. It uses the container's own nameserver, so it works on compose (127.0.0.11), the default bridge, and Kubernetes. It also creates the upload temp directory on the sites volume and fails loudly if the volume isn't writable by uid 101.

```sh
#!/bin/sh
set -eu
NS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
case "$NS" in *:*) NS="[$NS]" ;; esac
echo "resolver $NS valid=30s ipv6=off;" > /tmp/resolver.conf
mkdir -p /srv/sites/.tmp
```

### nginx.conf

```nginx
load_module modules/ngx_http_js_module.so;

worker_processes auto;
error_log /dev/stderr notice;
pid /tmp/nginx.pid;
events { worker_connections 4096; }

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    server_tokens off;
    sendfile on;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log /dev/stdout;

    include /tmp/resolver.conf;                      # written by 05-setup.sh

    # Non-root: every temp path must be writable. Uploads stay on the sites volume so PUT renames, not copies.
    client_body_temp_path /srv/sites/.tmp;
    proxy_temp_path   /tmp/proxy;
    fastcgi_temp_path /tmp/fastcgi;
    uwsgi_temp_path   /tmp/uwsgi;
    scgi_temp_path    /tmp/scgi;

    js_engine qjs;
    js_path /etc/nginx/njs;
    js_import auth from auth.js;
    js_fetch_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    js_fetch_protocols TLSv1.2 TLSv1.3;
    js_shared_dict_zone zone=verified:5m timeout=10m evict;
    js_shared_dict_zone zone=jwks:256k timeout=1h;

    log_format push '$remote_addr [$time_iso8601] "$request_method $uri" $status repo=$auth_repo';
    limit_req_zone $binary_remote_addr zone=push:10m rate=300r/s;

    # Unknown Host / bare IP: refuse the TLS handshake
    server {
        listen 8443 ssl default_server;
        ssl_reject_handshake on;
    }

    # Read: <label>.website-preview.chtc.io -> /srv/sites/<label>
    server {
        listen 8443 ssl;
        http2 on;
        server_name ~^(?<label>[a-z0-9-]+)\.website-preview\.chtc\.io$;
        ssl_certificate     /certs/tls.crt;
        ssl_certificate_key /certs/tls.key;

        if ($request_method !~ ^(GET|HEAD)$) { return 405; }

        root /srv/sites/$label;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Robots-Tag "noindex" always;
        location / { try_files $uri $uri/ =404; }
        location ~ /\. { deny all; }
    }

    # Push: the exact name wins over the regex above
    server {
        listen 8443 ssl;
        http2 on;
        server_name push.website-preview.chtc.io;
        ssl_certificate     /certs/tls.crt;
        ssl_certificate_key /certs/tls.key;
        access_log /dev/stdout push;

        root /srv/sites;
        client_max_body_size 100m;                   # per file, not per push

        location / {
            limit_req zone=push burst=1000 nodelay;
            auth_request /_verify;
            auth_request_set $auth_repo $sent_http_x_auth_repo;
            dav_methods PUT DELETE MKCOL;
            create_full_put_path on;
        }
        location = /_verify { internal; js_content auth.verify; }
    }

    # Healthcheck, container-local only
    server {
        listen 127.0.0.1:8081;
        access_log off;
        location = /healthz { return 200 "ok\n"; }
    }
}
```

### njs/auth.js

```js
import fs from 'fs';

const ISS = 'https://token.actions.githubusercontent.com';
const AUD = 'push.website-preview.chtc.io';
const WORKFLOW = 'CHTC/shared-workflows/.github/workflows/push.yml@refs/heads/main';
const CACHE_MS = 10 * 60 * 1000;                 // max life of a cached verification
const PR_REF = /^refs\/pull\/(\d+)\/merge$/;
// {"<repository_id>:<repository_owner_id>": "osg-htc-github-io-osg-htc", ...}
const SITES = JSON.parse(fs.readFileSync('/etc/nginx/sites.json', 'utf8'));

class Denied extends Error {
  constructor(reason, status = 403) { super(reason); this.status = status; }
}

const sha256hex = async (s) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(s))).toString('hex');
const bearer = (r) => (r.headersIn.Authorization || '').replace(/^Bearer /, '');
const unb64json = (s) => {
  try { return JSON.parse(Buffer.from(s, 'base64url').toString()); }
  catch (e) { throw new Denied('malformed', 401); }
};

async function getKeys(force) {
  const d = ngx.shared.jwks;
  const cached = d.get('keys');
  const c = cached ? JSON.parse(cached) : null;
  const age = c ? Date.now() - c.at : Infinity;
  if (c && age < 3600e3 && !(force && age > 60e3)) return c.keys;   // refetch on unknown kid, at most 1/min
  const r = await ngx.fetch(ISS + '/.well-known/jwks');
  if (!r.ok) throw new Error('jwks fetch ' + r.status);
  const keys = (await r.json()).keys;
  d.set('keys', JSON.stringify({ at: Date.now(), keys }));
  return keys;
}

async function verifyJwt(token) {
  const [h, p, s] = token.split('.');
  if (!s) throw new Denied('malformed', 401);
  const header = unb64json(h);
  if (header.alg !== 'RS256') throw new Denied('alg', 401);
  let jwk = (await getKeys(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Denied('kid', 401);
  const key = await crypto.subtle.importKey('jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`));
  if (!ok) throw new Denied('signature', 401);
  const c = unb64json(p);
  if (c.iss !== ISS || c.aud !== AUD) throw new Denied('iss_aud', 401);
  if (!(c.exp > Date.now() / 1000)) throw new Denied('expired', 401);
  return c;
}

function authorize(c, body) {
  const site = SITES[`${c.repository_id}:${c.repository_owner_id}`];
  if (!site) throw new Denied('repo_not_allowed');
  if (c.job_workflow_ref !== WORKFLOW) throw new Denied('wrong_workflow');
  switch (c.event_name) {
    case 'push':
    case 'workflow_dispatch':
      if (c.ref !== 'refs/heads/main' || c.ref_protected !== 'true') throw new Denied('ref');
      return `main-${site}`;
    case 'pull_request': {
      const m = PR_REF.exec(c.ref);
      if (!m) throw new Denied('ref');
      return `${m[1]}-${site}`;
    }
    case 'workflow_run':                           // fork previews, gated by an Environment
      if (!['preview', 'preview-auto'].includes(c.environment)) throw new Denied('environment');
      if (c.ref !== 'refs/heads/main' || c.ref_protected !== 'true') throw new Denied('ref');
      if (!Number.isInteger(body.pr) || body.pr <= 0) throw new Denied('pr');
      return `${body.pr}-${site}`;
    default:
      throw new Denied('event');
  }
}

function pathOk(raw, label, method) {
  let path;
  try { path = decodeURIComponent(raw.split('?')[0]); } catch (e) { return false; }
  if (path.includes('\0') || path.includes('\\') || !path.startsWith('/')) return false;
  let segs = path.slice(1).split('/');
  if (method === 'DELETE' && segs.at(-1) === '') segs = segs.slice(0, -1);   // DELETE /<label>/
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  return segs[0] === label && (method === 'DELETE' || segs.length > 1);
}

async function verify(r) {
  try {
    const tok = bearer(r);
    if (!tok) return r.return(401);
    const pr = r.headersIn['X-PR'] || '';            // only used for workflow_run; set by the pinned workflow
    const key = await sha256hex(`${tok}\n${pr}`);
    const hit = ngx.shared.verified.get(key);
    let s = hit ? JSON.parse(hit) : null;
    if (!s || s.exp < Date.now()) {                  // first sight (or expired): full verification
      const c = await verifyJwt(tok);
      const label = authorize(c, { pr: /^\d+$/.test(pr) ? Number(pr) : undefined });
      s = { label, repo: c.repository, exp: Math.min(c.exp * 1000, Date.now() + CACHE_MS) };
      ngx.shared.verified.set(key, JSON.stringify(s));
    }
    const method = r.variables.request_method;       // the original request's method
    if (!['PUT', 'MKCOL', 'DELETE'].includes(method) ||
        !pathOk(r.variables.request_uri, s.label, method)) {
      r.warn(`deny reason=path method=${method} repo=${s.repo}`);
      return r.return(403);
    }
    r.headersOut['X-Auth-Repo'] = s.repo;
    r.return(204);
  } catch (e) {
    if (e instanceof Denied) { r.warn(`deny reason=${e.message}`); return r.return(e.status); }
    r.error(`verify error: ${e}`);
    r.return(500);                                   // auth_request fails closed on 5xx
  }
}

export default { verify };
```

Notes on the script:

- It keeps no mutable globals. All state lives in the shared dictionaries, because njs contexts can be reused across requests.
- `js_preload_object` is not available on the QuickJS engine, so `sites.json` is read with `fs`. A change to the site table needs `nginx -s reload` (or a container restart).
- Failed verifications are not cached. Each bad token costs one RSA verify, and `limit_req` is the only brake.

### sites.json

Keys are `<repository_id>:<repository_owner_id>`; values are the `<repo>-<org>` part of the label. The IDs below are placeholders, and the repo owners need confirming.

```json
{
  "111111111:222222222": "chtc-website-source-chtc",
  "333333333:444444444": "osg-htc-github-io-osg-htc",
  "555555555:666666666": "pelicanplatform-github-io-pelicanplatform"
}
```

Generate the entries, then paste them in and remove the trailing comma:

```bash
for r in CHTC/chtc-website-source osg-htc/osg-htc.github.io PelicanPlatform/PelicanPlatform.github.io; do
  ids=$(gh api "repos/$r" --jq '"\(.id):\(.owner.id)"')
  label=$(printf '%s' "${r#*/}-${r%%/*}" | tr 'A-Z./' 'a-z--')
  printf '  "%s": "%s",\n' "$ids" "$label"
done
```

Validate before building. `<pr>-<label>` must stay under 63 characters:

```bash
jq -e 'all(.[]; test("^[a-z0-9-]{1,50}$"))' sites.json
```

## Build and run

```bash
docker build -t website-preview .

docker run -d --name website-preview -p 443:8443 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v /srv/sites:/srv/sites \
  -v /etc/website-preview/certs:/certs:ro \
  website-preview
```

- `/srv/sites` must be owned by uid 101: `sudo chown 101:101 /srv/sites`.
- The cert directory needs `tls.crt` and `tls.key`, readable by uid 101.
- Under compose, the same flags go in as `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, and `security_opt: ["no-new-privileges:true"]`.

## Local smoke test (no GitHub needed)

This generates a throwaway certificate inside a container, because macOS's `openssl` may not support `-addext`.

```bash
mkdir -p /tmp/wp-certs /tmp/wp-sites && chmod 777 /tmp/wp-sites
docker run --rm -v /tmp/wp-certs:/certs alpine/openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
  -keyout /certs/tls.key -out /certs/tls.crt \
  -subj "/CN=*.website-preview.chtc.io" -addext "subjectAltName=DNS:*.website-preview.chtc.io"
chmod 644 /tmp/wp-certs/*

docker run -d --name wp-test -p 8443:8443 --read-only --tmpfs /tmp \
  -v /tmp/wp-certs:/certs:ro -v /tmp/wp-sites:/srv/sites website-preview
sleep 3; docker logs wp-test

# the image has the modules the config needs
docker exec wp-test sh -c 'nginx -V 2>&1 | tr " " "\n" | grep -E "http_dav|auth_request"; dpkg -s nginx-module-njs | grep ^Version'
docker exec wp-test curl -fsS http://127.0.0.1:8081/healthz                                       # ok

P="--resolve push.website-preview.chtc.io:8443:127.0.0.1 --resolve 1-x.website-preview.chtc.io:8443:127.0.0.1 -k"
curl -s -o /dev/null -w '%{http_code}\n' $P https://push.website-preview.chtc.io:8443/                  # 401 (exact name beat the regex)
curl -s -o /dev/null -w '%{http_code}\n' $P -X PUT --data x https://push.website-preview.chtc.io:8443/1-x/a.txt   # 401
curl -s -o /dev/null -w '%{http_code}\n' $P -X PUT --data x -H 'Authorization: Bearer bogus' https://push.website-preview.chtc.io:8443/1-x/a.txt   # 401
curl -s -o /dev/null -w '%{http_code}\n' $P -X PUT --data x https://1-x.website-preview.chtc.io:8443/a.txt   # 405
curl -s -o /dev/null -w '%{http_code}\n' $P https://1-x.website-preview.chtc.io:8443/a.txt                   # 404
curl -sk https://127.0.0.1:8443/ ; echo "curl exit $?"                                                       # handshake refused (35)
docker rm -f wp-test
```

If the `nginx -V` line prints nothing, the image lacks the DAV or `auth_request` module and needs a different base image.

Only a real GitHub token exercises `verify` and `authorize`, so those are tested by the first workflow run. The denial reasons in `docker logs` say what to fix.

## Workflow side

Changes to the reusable workflow `CHTC/shared-workflows/.github/workflows/push.yml`: the audience becomes the push host, there is no session exchange, and the token goes on every request. Without a `/session` response, the workflow computes the directory label itself, using the rule above.

Add an optional input for fork previews:

```yaml
on:
  workflow_call:
    inputs:
      artifact-name: { type: string, default: site }
      pr-number:     { type: string, default: '' }   # only for workflow_run fork previews
```

The push step:

```yaml
      - name: Push
        env:
          PUSH_HOST: push.website-preview.chtc.io
          PR_INPUT: ${{ inputs.pr-number }}
        run: |
          set -euo pipefail

          # 1. OIDC token, audience = push host. It goes on every request.
          OIDC=$(curl -sS --fail -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
                 "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$PUSH_HOST" | jq -r .value)
          echo "::add-mask::$OIDC"

          # 2. Directory label: <pr|main>-<repo>-<org>, lowercase, dots and slashes -> hyphens
          repo=${GITHUB_REPOSITORY#*/}; org=${GITHUB_REPOSITORY%%/*}
          SITE=$(printf '%s' "$repo-$org" | tr 'A-Z./' 'a-z--')
          case "$GITHUB_EVENT_NAME" in
            pull_request) PR=${GITHUB_REF_NAME%%/*} ;;   # refs/pull/<n>/merge
            workflow_run) PR=$PR_INPUT ;;                # looked up by the trusted caller, never from the artifact
            *)            PR= ;;
          esac
          LABEL="${PR:-main}-$SITE"
          XPR=""; if [ "$GITHUB_EVENT_NAME" = workflow_run ]; then XPR=$PR; fi
          export OIDC PUSH_HOST LABEL XPR

          # 3. Wipe the old site (404 on the first push is fine)
          curl -sS -X DELETE -H "Authorization: Bearer $OIDC" ${XPR:+-H "X-PR: $XPR"} \
               "https://$PUSH_HOST/$LABEL/" || true

          # 4. One config block per file. Options reset at each `next`,
          #    so the headers and retry settings go in every block.
          python3 - <<'PY' > /tmp/uploads.cfg
          import os, sys, urllib.parse as u
          q = lambda s: s.replace('\\', '\\\\').replace('"', '\\"')
          base = f"https://{os.environ['PUSH_HOST']}/{os.environ['LABEL']}/"
          first = True
          for root, _, files in os.walk('site'):
              for f in files:
                  p = os.path.join(root, f)
                  if os.path.islink(p) or not os.path.isfile(p):
                      sys.exit(f'refusing non-regular file: {p}')
                  rel = os.path.relpath(p, 'site').replace(os.sep, '/')
                  if not first: print('next')
                  first = False
                  print(f'upload-file = "{q(p)}"')
                  print(f'url = "{q(base + u.quote(rel))}"')
                  print(f'header = "Authorization: Bearer {os.environ["OIDC"]}"')
                  if os.environ['XPR']: print(f'header = "X-PR: {os.environ["XPR"]}"')
                  print('fail-with-body')
                  print('retry = 3')
          PY
          chmod 600 /tmp/uploads.cfg

          # 5. Multiplexed upload
          curl -sS --parallel --parallel-max 16 --config /tmp/uploads.cfg
          rm -f /tmp/uploads.cfg
          echo "Pushed to https://$LABEL.website-preview.chtc.io/" >> "$GITHUB_STEP_SUMMARY"
```

Callers keep the two-job layout: a build job without `id-token`, and a push job that calls the reusable workflow with `permissions: id-token: write, contents: read`. For fork previews, the trusted `workflow_run` caller looks up the PR number through the GitHub API and passes it as `pr-number`.

## What `authorize()` accepts

All checks run on the verified token's claims.

| Claim | Required value |
| --- | --- |
| Signature | RS256, against GitHub's JWKS at `https://token.actions.githubusercontent.com/.well-known/jwks` |
| `iss`, `aud` | `https://token.actions.githubusercontent.com`, `push.website-preview.chtc.io` |
| `exp` | Not expired |
| `repository_id` + `repository_owner_id` | A key in `sites.json` |
| `job_workflow_ref` | Exactly `CHTC/shared-workflows/.github/workflows/push.yml@refs/heads/main` |
| `push` / `workflow_dispatch` | `ref` is `refs/heads/main` and `ref_protected` is `"true"`; label `main-<site>` |
| `pull_request` | `ref` matches `refs/pull/<n>/merge`; label `<n>-<site>`; forks get no token |
| `workflow_run` | `environment` is `preview` or `preview-auto`, `ref` is protected `main`, and `X-PR` is a positive integer; label `<X-PR>-<site>` |

## Limits to know about

- **No replay protection or revocation.** A leaked token works until its `exp`, for anything `authorize()` allows. The cache never extends that window.
- **Push duration.** A push must finish within the OIDC token's lifetime. The exact lifetime isn't confirmed, so test with your largest build.
- **Cold start.** The first parallel requests all miss the cache and each verify the signature once. Later requests are a hash lookup.
- **`X-PR` is trusted.** `authorize()` reads it only for `workflow_run`, and only the pinned shared workflow sets it. A stolen token plus a forged `X-PR` can still only reach that repo's own preview directories.
- **Process boundary.** The checker runs inside the nginx worker, which has write access to `/srv/sites`. Keep the image current: njs 1.0.1 fixed three security issues.

## Verified so far

From test runs of `nginx:latest`:

- nginx 1.31.8 with njs 1.0.2 (package `1.31.8+1.0.2-1~trixie`).
- Module files `ngx_http_js_module.so` and `ngx_stream_js_module.so` are present.
- `js_engine qjs;` and `js_shared_dict_zone` pass `nginx -t`.
- `/etc/ssl/certs/ca-certificates.crt` exists.
- `ngx.fetch` of GitHub's JWKS returned `status=200 keys=4` with `js_fetch_protocols TLSv1.2 TLSv1.3`.

## Still unconfirmed

- The image has `http_dav_module` and `http_auth_request_module` (the `nginx -V` line in the smoke test checks this).
- `$request_method` reports the original method (`PUT`) inside the auth subrequest, and `$sent_http_x_auth_repo` fills `repo=` in the push log. One authenticated `PUT` and one `GET` against a real token confirm both.
- WebCrypto `importKey` with a GitHub JWK, and `verify`, against a real token.
- `ref_protected` is `"true"` under your branch rulesets, and the exact `job_workflow_ref` string for a reusable workflow.
- `curl --parallel` exits non-zero when a single transfer fails. Test with one deliberately bad file.
