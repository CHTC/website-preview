import fs from 'fs';

const ROOT = '/srv/sites';
const CAPACITY_FILE = '/tmp/sites-capacity';   // volume size in KiB, written by 05-setup.sh
const PERCENT = Number(process.env.PRUNE_PERCENT || 90);

// Run fn, treating a path that a push deleted mid-walk as empty
function ifExists(fn, fallback) {
  try { return fn(); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

// Bytes allocated under path, like `du`
function du(path) {
  return ifExists(() => {
    const st = fs.lstatSync(path);
    let total = st.blocks * 512;
    if (st.isDirectory()) for (const name of fs.readdirSync(path)) total += du(`${path}/${name}`);
    return total;
  }, 0);
}

// Site directories, oldest push first. .tmp holds in-flight uploads and is skipped.
function sites() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const path = `${ROOT}/${d.name}`;
      return { label: d.name, path, mtime: ifExists(() => fs.lstatSync(path).mtimeMs, 0), size: du(path) };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

// Delete the oldest sites until they use at most PERCENT of the volume
function run() {
  try {
    const limit = Number(fs.readFileSync(CAPACITY_FILE, 'utf8')) * 1024 * PERCENT / 100;
    if (!(limit > 0)) throw new Error(`bad capacity in ${CAPACITY_FILE}`);
    const all = sites();
    let used = all.reduce((n, s) => n + s.size, 0);
    for (const s of all) {
      if (used <= limit) break;
      ifExists(() => fs.rmdirSync(s.path, { recursive: true }));
      used -= s.size;
      ngx.log(ngx.WARN, `prune ${s.label} ${s.size}B, sites now ${used}B of ${limit}B allowed`);
    }
  } catch (e) {
    ngx.log(ngx.ERR, `prune error: ${e}`);
  }
}

export default { run };
