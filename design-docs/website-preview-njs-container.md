# website-preview: minimal nginx + njs push container

A single nginx container that hosts static PR preview builds and accepts WebDAV pushes from one reusable GitHub workflow. All authorization is done inside nginx by an njs script that verifies the workflow's GitHub OIDC token.

- Push URL: `https://push.website-preview.chtc.io`
- Site URLs: `https://<label>.website-preview.chtc.io`, where `<label>` is `<pr>-<repo>-<org>`
- Date written: 2026-10-27

## How it works

1. The push job, triggered by a push to a branch with an open PR, asks GitHub for an OIDC token with audience `push.website-preview.chtc.io`.
2. The job sends that token on every request (`Authorization: Bearer ...`).
3. For each `PUT`/`DELETE`, nginx runs `auth_request` against an internal njs handler (`auth.verify`).
4. The handler looks up `sha256(token)` in a shared-memory cache.
   - **Hit:** reuse the stored result.
   - **Miss:** verify the RS256 signature against GitHub's JWKS, check the claims, run `authorize()`, and cache the result until the token's own `exp` or 10 minutes, whichever is sooner.
5. The handler then checks the method and the percent-decoded path against the label that `authorize()` produced. A `204` lets nginx's DAV module write the file.

The server derives the directory from the token's `repository_id` and `ref`, never from anything the workflow sends, so one repo cannot write another repo's directory.

## DNS and TLS

One wildcard record covers everything, including the push host:

```
*.website-preview.chtc.io.   300 IN A   <Traefik host IP>
```

- Traefik terminates TLS with a `*.website-preview.chtc.io` certificate (Let's Encrypt needs DNS-01 for wildcards) and forwards plain HTTP to the container on port 8080, keeping the original `Host` header.
- The push host also matches the read host's pattern; nginx picks the exact name. Never create a site whose label is exactly `push`.
- Labels must not contain dots, because a wildcard matches one DNS label only.

## Directory labels

The label is `<pr-number>-<repo>-<org>`, lowercased, with `.` and `/` turned into `-`. For example, PR 42 on `osg-htc/osg-htc.github.io` is `42-osg-htc-github-io-osg-htc`.

Both the workflow and `sites.json` must produce the same string. A mismatch fails closed with a 403 and `reason=path` in the log.

```bash
printf '%s' "$repo-$org" | tr 'A-Z./' 'a-z--'
```

## Configuration

| Variable | Value |
| --- | --- |
| `OIDC_ISSUER` | `https://token.actions.githubusercontent.com` |
| `OIDC_AUDIENCE` | `push.website-preview.chtc.io` |
| `PUSH_WORKFLOW_REF` | `CHTC/website-preview/.github/workflows/push.yml@refs/heads/main` |
| `PRUNE_PERCENT` | Optional, default `90`. The share of the sites volume the site builds may use before the oldest are deleted. |

The first three are required; if any is missing, every push fails with a 500 and the reason in the error log.

## Files

| File | Purpose |
| --- | --- |
| [`Dockerfile`](../Dockerfile) | `nginx:latest` plus the config, scripts and `sites.json`; runs as uid 101 on port 8080. |
| [`nginx.conf`](../nginx.conf) | Read host (`GET`/`HEAD` from `/srv/sites/<label>`), push host (`PUT`/`DELETE` behind `auth_request`), and a container-local health check and prune schedule. |
| [`njs/auth.js`](../njs/auth.js) | Verifies the OIDC token, runs `authorize()`, and checks the request path against the label. |
| [`njs/prune.js`](../njs/prune.js) | Hourly pruning, run by `js_periodic`. |
| [`sites.json`](../sites.json) | Allowed repos: `"<repository_id>:<repository_owner_id>": "<repo>-<org>"`. Changing it needs an image rebuild. |
| [`docker-entrypoint.d/05-setup.sh`](../docker-entrypoint.d/05-setup.sh) | Writes the nginx resolver from `/etc/resolv.conf`, creates `/srv/sites/.tmp`, and records the volume size for `prune.js`. |
| [`.github/workflows/push.yml`](../.github/workflows/push.yml) | The reusable push workflow. |

See the [README](../README.md) for deploying on Kubernetes and adding a site.

## Pruning

Every hour, `prune.js` totals the space used by the site directories. If that is more than `PRUNE_PERCENT` of the volume, it deletes whole site directories, oldest first (FIFO), until usage is back under the limit. "Oldest" is the directory's modification time, which is the site's latest push, because every push deletes and recreates its directory. `.tmp` is skipped. Each deletion is logged at `warn` as `js: prune <label> ...`.

## Workflow

[`push.yml`](../.github/workflows/push.yml) downloads the caller's GitHub Pages artifact (`github-pages` by default), unpacks its `artifact.tar`, deletes the old preview, and uploads every file with `curl --parallel`. Runs for the same PR share a `concurrency` group, so a newer commit cancels an older push.

Callers trigger on `pull_request`, with a build job that ends with `actions/upload-pages-artifact` and a push job that calls the reusable workflow:

```yaml
on: pull_request

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4
      # ... build into ./out ...
      - uses: actions/upload-pages-artifact@v3
        with: { path: out }

  preview:
    needs: build
    permissions: { id-token: write, contents: read }
    uses: CHTC/website-preview/.github/workflows/push.yml@main
```

## What `authorize()` accepts

All checks run on the verified token's claims.

| Claim | Required value |
| --- | --- |
| Signature | RS256, against the JWKS at `$OIDC_ISSUER/.well-known/jwks` |
| `iss`, `aud` | `$OIDC_ISSUER`, `$OIDC_AUDIENCE` |
| `exp` | Not expired |
| `repository_id` + `repository_owner_id` | A key in `sites.json` |
| `job_workflow_ref` | Exactly `$PUSH_WORKFLOW_REF` |
| `event_name` | `pull_request`; forks get no token |
| `ref` | Matches `refs/pull/<n>/merge`; label `<n>-<site>` |

## Local smoke test

No GitHub token needed. These check the routing and rejections, not a real push.

```bash
docker build -t website-preview .
mkdir -p /tmp/wp-sites && chmod 777 /tmp/wp-sites
docker run -d --name wp-test -p 8080:8080 --read-only --tmpfs /tmp \
  -e OIDC_ISSUER=https://token.actions.githubusercontent.com \
  -e OIDC_AUDIENCE=push.website-preview.chtc.io \
  -e PUSH_WORKFLOW_REF=CHTC/website-preview/.github/workflows/push.yml@refs/heads/main \
  -v /tmp/wp-sites:/srv/sites website-preview

P="--resolve push.website-preview.chtc.io:8080:127.0.0.1 --resolve 1-x.website-preview.chtc.io:8080:127.0.0.1"
curl -s -o /dev/null -w '%{http_code}\n' $P http://push.website-preview.chtc.io:8080/                   # 401
curl -s -o /dev/null -w '%{http_code}\n' $P -X PUT --data x -H 'Authorization: Bearer bogus' http://push.website-preview.chtc.io:8080/1-x/a.txt   # 401
curl -s -o /dev/null -w '%{http_code}\n' $P -X PUT --data x http://1-x.website-preview.chtc.io:8080/a.txt    # 405
curl -s -o /dev/null -w '%{http_code}\n' $P http://1-x.website-preview.chtc.io:8080/a.txt                    # 404
curl -s http://127.0.0.1:8080/ ; echo "curl exit $?"                                                         # 52
docker rm -f wp-test
```

## Limits to know about

- **No replay protection or revocation.** A leaked token works until its `exp`, for anything `authorize()` allows.
- **Push duration.** A push must finish within the OIDC token's lifetime. Test with your largest build.
- **Pruning is hourly.** The volume can fill between runs, and then pushes fail until the next run frees space. A push in progress on the oldest site can be pruned partway through.
- **Pruning blocks one worker** while it walks the site directories.
- **Capacity is read at startup.** If the sites volume is resized, restart the container.
- **Client address.** Behind Traefik, `$remote_addr` is Traefik's address, so the push rate limit and the push log see one client for all traffic.
- **Process boundary.** The checker runs inside the nginx worker, which has write access to `/srv/sites`. Keep the image current.

## Still unconfirmed

Check these on the first real push:

- `$request_method` reports the original method (`PUT`) inside the auth subrequest, and `repo=` is filled in the push log.
- WebCrypto `importKey` and `verify` accept a real GitHub token.
- The exact `job_workflow_ref` string for a reusable workflow.
