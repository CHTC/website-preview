# website-preview

One nginx container that serves PR preview builds at `https://<pr>-<repo>-<org>.website-preview.chtc.io/` and accepts pushes from the reusable workflow in `.github/workflows/push.yml`. Pushes are authorized by an njs script that verifies the workflow's GitHub OIDC token. See [the design doc](design-docs/website-preview-njs-container.md) for how it works.

## Deploying on Kubernetes

Traefik terminates TLS and forwards plain HTTP to the pod on port 8080. The pod needs:

- one replica, because the sites volume is `ReadWriteOnce` and the verification cache is per pod
- a persistent volume at `/srv/sites`, writable by uid/gid 101
- a writable `emptyDir` at `/tmp`, because the root filesystem is read-only
- the environment variables below

### Environment

| Variable | Required | Value |
| --- | --- | --- |
| `OIDC_ISSUER` | yes | `https://token.actions.githubusercontent.com` |
| `PREVIEW_DOMAIN` | yes | `website-preview.chtc.io`. Sites are served at `<label>.<domain>`, pushes go to `push.<domain>`, and that push host is the OIDC audience. Site repos pass the same value as the workflow's `domain` input. |
| `PUSH_WORKFLOW_REF` | yes | `CHTC/website-preview/.github/workflows/push.yml@refs/heads/main` |
| `PRUNE_PERCENT` | no | Share of the sites volume the builds may use before the oldest are deleted. Default `90`. |

If `PREVIEW_DOMAIN` is missing or isn't a lowercase host name, the container exits at startup. If either other required variable is missing, every push fails with a 500 and `verify error: ...` in the pod log.

### DNS

One wildcard record pointing at the Traefik load balancer covers the push host and every site:

```
*.website-preview.chtc.io.   300 IN A   <Traefik load balancer IP>
```

### Manifests

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: website-preview-sites
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 20Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: website-preview
spec:
  replicas: 1
  strategy:
    type: Recreate                       # RWO volume: the old pod must let go first
  selector:
    matchLabels: { app: website-preview }
  template:
    metadata:
      labels: { app: website-preview }
    spec:
      securityContext:
        runAsUser: 101
        runAsGroup: 101
        runAsNonRoot: true
        fsGroup: 101                     # makes the sites volume writable by nginx
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: nginx
          image: hub.opensciencegrid.org/chtc/website-preview
          ports:
            - { name: http, containerPort: 8080 }
          env:
            - { name: OIDC_ISSUER, value: https://token.actions.githubusercontent.com }
            - { name: PREVIEW_DOMAIN, value: website-preview.chtc.io }
            - { name: PUSH_WORKFLOW_REF, value: CHTC/website-preview/.github/workflows/push.yml@refs/heads/main }
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
          # The health endpoint listens on 127.0.0.1 only, so probe from inside the container
          livenessProbe:
            exec: { command: [curl, -fsS, http://127.0.0.1:8081/healthz] }
            periodSeconds: 30
          readinessProbe:
            tcpSocket: { port: http }
            periodSeconds: 10
          volumeMounts:
            - { name: sites, mountPath: /srv/sites }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: sites
          persistentVolumeClaim: { claimName: website-preview-sites }
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: website-preview
spec:
  selector: { app: website-preview }
  ports:
    - { name: http, port: 80, targetPort: http }
```

Things to check for your cluster:

- **Certificate.** The ingress needs a `*.website-preview.chtc.io` certificate, which Let's Encrypt only issues over DNS-01.
- **Volume size.** Pruning uses the volume size `df` reports at pod start, so use storage that enforces the claim size (not a shared NFS export), and restart the pod after resizing.
- **Host header.** Traefik forwards the original `Host` by default. nginx picks the site from it, so leave that on.
- **Client address.** nginx sees Traefik's address on every request, so the push rate limit (300 requests/s) is shared by all pushers.

### Verify the deployment

```bash
kubectl logs deploy/website-preview                     # nginx started, no "verify error" or "prune error"
curl -s -o /dev/null -w '%{http_code}\n' https://push.website-preview.chtc.io/              # 401
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --data x https://1-x.website-preview.chtc.io/a  # 405
```

Push denials are logged at `warn` as `js: deny reason=<reason>`, and pruning as `js: prune <label> ...`.

## Adding a site

Site repos are allowed by `sites.json`, keyed on `<repository_id>:<repository_owner_id>`. Look up the IDs:

```bash
curl -fsS https://api.github.com/repos/<org>/<repo> | jq -r '"\(.id):\(.owner.id)"'
```

Add the entry with the label `<repo>-<org>` (lowercase, `.` and `/` become `-`), check it with `jq -e 'all(.[]; test("^[a-z0-9-]{1,50}$"))' sites.json`, then rebuild the image and roll the deployment.

## Using it from a site repo

The site's workflow runs on `pull_request`, uploads its build with `actions/upload-pages-artifact`, and calls the reusable workflow:

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
    # with: { domain: website-preview.chtc.chtc.io }   # the server's PREVIEW_DOMAIN; this is the default
```

The preview appears at `https://<pr>-<repo>-<org>.<domain>/`, and the link is added to the job summary. PRs from forks get no OIDC token, so they can't push previews.
