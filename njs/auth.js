import fs from 'fs';

const ISS = process.env.OIDC_ISSUER;
const AUD = process.env.OIDC_AUDIENCE;
const WORKFLOW = process.env.PUSH_WORKFLOW_REF;
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

function authorize(c) {
  const site = SITES[`${c.repository_id}:${c.repository_owner_id}`];
  if (!site) throw new Denied('repo_not_allowed');
  if (c.job_workflow_ref !== WORKFLOW) throw new Denied('wrong_workflow');
  if (c.event_name !== 'pull_request') throw new Denied('event');
  const m = PR_REF.exec(c.ref);
  if (!m) throw new Denied('ref');
  return `${m[1]}-${site}`;
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
    if (!ISS || !AUD || !WORKFLOW) throw new Error('OIDC_ISSUER, OIDC_AUDIENCE and PUSH_WORKFLOW_REF must be set');
    const tok = bearer(r);
    if (!tok) return r.return(401);
    const key = await sha256hex(tok);
    const hit = ngx.shared.verified.get(key);
    let s = hit ? JSON.parse(hit) : null;
    if (!s || s.exp < Date.now()) {                  // first sight (or expired): full verification
      const c = await verifyJwt(tok);
      const label = authorize(c);
      s = { label, repo: c.repository, exp: Math.min(c.exp * 1000, Date.now() + CACHE_MS) };
      ngx.shared.verified.set(key, JSON.stringify(s));
    }
    const method = r.variables.request_method;       // the original request's method
    if (!['PUT', 'DELETE'].includes(method) ||
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
