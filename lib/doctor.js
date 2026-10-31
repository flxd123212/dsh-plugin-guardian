/**
 * Guardian core — everything that must work even when the harness itself
 * cannot boot: locating the profile, reading manifests, grading compatibility
 * against the running dsh, checking the registry, and rewriting
 * `dsh.profile.bundles`.
 *
 * No cordis, no HTTP, no renderer: `bin/guardian.js` (CLI) and `lib/index.js`
 * (the in-harness plugin) both build on this module.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const STATE_VERSION = 1;
export const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
export const FETCH_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// Environment discovery (works from a CLI, no runtime needed)
// ---------------------------------------------------------------------------

export function defaultDshHome() {
  const env = String(process.env.DSH_HOME || '').trim();
  if (env) return env;
  return path.join(os.homedir(), '.dsh');
}

/** Latest installed dsh CLI entry; the same hunt the desktop shell does. */
export function detectRuntimeBin() {
  const explicit = String(process.env.BIGFISH_DSH_BIN || process.env.DSH_BIN || '').trim();
  if (explicit && exists(explicit)) return explicit;
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const local = process.env.LOCALAPPDATA || '';
    if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    if (local) {
      for (const major of ['5', '4']) {
        candidates.push(path.join(local, 'pnpm', 'global', major, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
      }
    }
  } else {
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
    candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  }
  const present = candidates.filter(exists);
  if (present.length === 0) return undefined;
  let best = present[0];
  let bestVersion = versionOfEntry(best);
  for (const candidate of present.slice(1)) {
    const version = versionOfEntry(candidate);
    if (version && (!bestVersion || compareVersions(version, bestVersion) > 0)) {
      best = candidate;
      bestVersion = version;
    }
  }
  return best;
}

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function versionOfEntry(binPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(binPath)), 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

let semverLib;
function semver(runtimeBin) {
  if (semverLib !== undefined) return semverLib;
  semverLib = null;
  try {
    if (runtimeBin) {
      const require = createRequire(path.join(path.dirname(path.dirname(runtimeBin)), 'package.json'));
      semverLib = require('semver');
    }
  } catch {
    semverLib = null;
  }
  return semverLib;
}

function parseVersion(value) {
  const text = String(value || '').trim().replace(/^[~^=v]+/, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

export function compareVersions(a, b, runtimeBin) {
  const lib = semver(runtimeBin);
  if (lib) {
    try {
      const cmp = lib.compare(String(a), String(b));
      if (Number.isFinite(cmp)) return cmp;
    } catch {
      /* fall through */
    }
  }
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) > Number(y) ? 1 : -1;
    if (nx) return -1;
    if (ny) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function satisfies(version, range, runtimeBin) {
  const text = String(range || '').trim();
  if (!text) return false;
  const lib = semver(runtimeBin);
  if (lib) {
    try {
      return lib.satisfies(String(version), text, { includePrerelease: true });
    } catch {
      return false;
    }
  }
  if (text === '*' || text === 'x') return true;
  if (text.startsWith('^') || text.startsWith('~')) return compareVersions(version, text.slice(1), runtimeBin) >= 0;
  if (text.startsWith('>=')) return compareVersions(version, text.slice(2), runtimeBin) >= 0;
  if (text.startsWith('<')) return compareVersions(version, text.slice(1), runtimeBin) < 0;
  return compareVersions(version, text, runtimeBin) === 0;
}

/** Mirrors dsh-app-boot: `engines.dsh` alone, else every `@deepseek-ai/dsh*` peer. */
export function unmetRequirements(manifest, runtimeVersion, runtimeBin) {
  if (!manifest || typeof manifest !== 'object') return null;
  const engines = manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : {};
  if (typeof engines.dsh === 'string') {
    return satisfies(runtimeVersion, engines.dsh, runtimeBin) ? null : { 'engines.dsh': engines.dsh };
  }
  const peers = manifest.peerDependencies && typeof manifest.peerDependencies === 'object'
    ? manifest.peerDependencies
    : {};
  const unmet = {};
  for (const [dep, range] of Object.entries(peers)) {
    if (dep !== '@deepseek-ai/dsh' && !dep.startsWith('@deepseek-ai/dsh-')) continue;
    if (typeof range !== 'string') continue;
    if (!satisfies(runtimeVersion, range, runtimeBin)) unmet[dep] = range;
  }
  return Object.keys(unmet).length > 0 ? unmet : null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function npmLatest(pkgName) {
  for (const registry of NPM_REGISTRIES) {
    const encoded = pkgName.startsWith('@')
      ? `@${encodeURIComponent(pkgName.slice(1))}`
      : encodeURIComponent(pkgName);
    const data = await fetchJson(`${registry}/${encoded}/latest`, 6000);
    if (data && typeof data === 'object' && typeof data.version === 'string') return data;
  }
  return null;
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

const GIT_SPEC = /^(git[+:]|https?:\/\/|github:|gitlab:|file:|link:)/i;

export function isRegistrySpec(spec) {
  return !GIT_SPEC.test(String(spec || ''));
}

// ---------------------------------------------------------------------------
// The doctor
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {string} [options.dshHome]   defaults to $DSH_HOME or ~/.dsh
 * @param {string} [options.profile]   profile name, defaults to "web"
 * @param {string} [options.runtimeBin] dsh bin.js used to read the runtime version
 */
export function createDoctor(options = {}) {
  const env = {
    dshHome: options.dshHome || defaultDshHome(),
    profile: options.profile || 'web',
    runtimeBin: options.runtimeBin || detectRuntimeBin(),
  };

  const profileDir = () => path.join(env.dshHome, 'profiles', env.profile);
  const stateDir = () => path.join(env.dshHome, 'guardian');
  // One state file per profile: `web`, `tui` and friends must not clobber each
  // other's suspended list or panel token.
  const statePath = () => path.join(stateDir(), `state.${env.profile.replace(/[^a-z0-9._-]/gi, '_')}.json`);
  const legacyStatePath = () => path.join(stateDir(), 'state.json');

  function runtimeVersion() {
    return env.runtimeBin ? versionOfEntry(env.runtimeBin) || '0.0.0' : '0.0.0';
  }

  function packageManifest(pkgName) {
    return readJson(path.join(profileDir(), 'node_modules', pkgName, 'package.json'));
  }

  const profileManifestPath = () => path.join(profileDir(), 'package.json');
  const readProfileManifest = () => {
    const manifest = readJson(profileManifestPath());
    return manifest && typeof manifest === 'object' ? manifest : null;
  };
  const writeProfileManifest = (manifest) => writeJsonAtomic(profileManifestPath(), manifest);

  function profileDependencies() {
    const manifest = readProfileManifest();
    const deps = manifest && manifest.dependencies && typeof manifest.dependencies === 'object'
      ? manifest.dependencies
      : {};
    return Object.entries(deps)
      .filter(([dep]) => !dep.startsWith('@deepseek-ai/'))
      .map(([dep, spec]) => ({ name: dep, spec: String(spec) }));
  }

  function profileBundles() {
    const manifest = readProfileManifest();
    const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
      ? manifest.dsh.profile.bundles
      : [];
    return bundles.slice();
  }

  function setBundles(next) {
    const manifest = readProfileManifest();
    if (!manifest) throw new Error('无法读取 profile manifest，已中止（防止清空插件注册表）');
    if (!manifest.dsh || typeof manifest.dsh !== 'object') manifest.dsh = {};
    if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {};
    manifest.dsh.profile.bundles = next;
    writeProfileManifest(manifest);
  }

  // ---- state ------------------------------------------------------------

  function defaultState() {
    return {
      version: STATE_VERSION,
      token: randomUUID().replace(/-/g, ''),
      runtime: runtimeVersion(),
      profile: env.profile,
      checkedAt: 0,
      // Opt-in: a fresh install only diagnoses. Existing profiles that already
      // enabled it keep their choice in state.json.
      autoSuspend: false,
      plugins: [],
      pendingSuspend: [],
      suspended: [],
      history: [],
    };
  }

  let cache = null;
  function loadState() {
    let stored = readJson(statePath());
    if (!stored) {
      // Migrate the pre-0.1.3 shared file when it belongs to this profile.
      const legacy = readJson(legacyStatePath());
      if (legacy && legacy.profile === env.profile) stored = legacy;
    }
    const base = defaultState();
    if (!stored || typeof stored !== 'object') return base;
    const merged = { ...base, ...stored };
    merged.version = STATE_VERSION;
    merged.token = typeof stored.token === 'string' && stored.token.length >= 16 ? stored.token : base.token;
    merged.plugins = Array.isArray(stored.plugins) ? stored.plugins : [];
    merged.pendingSuspend = Array.isArray(stored.pendingSuspend) ? stored.pendingSuspend : [];
    merged.suspended = Array.isArray(stored.suspended) ? stored.suspended : [];
    merged.history = Array.isArray(stored.history) ? stored.history : [];
    merged.runtime = runtimeVersion();
    merged.profile = env.profile;
    return merged;
  }

  function state() {
    if (!cache) cache = loadState();
    return cache;
  }

  function saveState() {
    try {
      writeJsonAtomic(statePath(), state());
    } catch (error) {
      console.error(`[guardian] 写入状态失败: ${(error && error.message) || error}`);
    }
  }

  function note(entry) {
    const current = state();
    current.history.unshift({ at: nowIso(), ...entry });
    current.history = current.history.slice(0, 50);
  }

  // ---- diagnosis --------------------------------------------------------

  function scan() {
    const current = state();
    const runtime = runtimeVersion();
    const bundles = new Set(profileBundles());
    const deps = profileDependencies();
    const suspended = new Set(current.suspended);

    const names = [...new Set([...deps.map((dep) => dep.name), ...bundles])]
      .filter((dep) => typeof dep === 'string' && dep.length > 0 && !dep.startsWith('@deepseek-ai/'))
      .sort();

    const previous = new Map((current.plugins || []).map((plugin) => [plugin.name, plugin]));
    const plugins = names.map((depName) => {
      const spec = (deps.find((dep) => dep.name === depName) || {}).spec || '';
      const manifest = packageManifest(depName);
      const installed = manifest && typeof manifest.version === 'string' ? manifest.version : '';
      const unmet = manifest ? unmetRequirements(manifest, runtime, env.runtimeBin) : null;
      const compat = !manifest ? 'missing' : unmet ? 'incompatible' : 'ok';
      const old = previous.get(depName) || {};
      return {
        name: depName,
        spec,
        installed,
        bundled: bundles.has(depName),
        suspended: suspended.has(depName),
        compat,
        unmet: unmet || undefined,
        latest: old.latest || '',
        latestCompatible: old.latestCompatible || '',
        update: old.update || 'unknown',
        checkedAt: old.checkedAt || 0,
      };
    });

    current.runtime = runtime;
    current.plugins = plugins;
    const incompatibleBundles = plugins.filter((plugin) => plugin.compat === 'incompatible' && plugin.bundled);
    current.pendingSuspend = current.autoSuspend ? incompatibleBundles.map((plugin) => plugin.name) : [];
    saveState();
    return current;
  }

  async function checkUpdates() {
    const current = scan();
    const runtime = current.runtime;
    const candidates = current.plugins.filter((plugin) => plugin.installed && isRegistrySpec(plugin.spec));

    await mapLimit(candidates, 4, async (plugin) => {
      const latest = await npmLatest(plugin.name);
      plugin.checkedAt = Date.now();
      if (!latest) return;
      plugin.latest = latest.version;
      const unmet = unmetRequirements(
        { engines: latest.engines, peerDependencies: latest.peerDependencies },
        runtime,
        env.runtimeBin,
      );
      plugin.latestCompatible = unmet ? '' : latest.version;
      if (compareVersions(latest.version, plugin.installed, env.runtimeBin) <= 0) {
        plugin.update = 'none';
      } else if (unmet) {
        plugin.update = 'blocked';
        plugin.unmet = unmet;
      } else {
        plugin.update = 'available';
      }
    });

    current.checkedAt = Date.now();
    saveState();
    return current;
  }

  // ---- mutations --------------------------------------------------------

  async function runPnpm(args, timeoutMs = 8 * 60 * 1000) {
    if (!env.runtimeBin) return { code: -1, output: '找不到 dsh 入口，无法安装（可用 --runtime 指定）' };
    const argv = [env.runtimeBin, 'plugin', '--profile', env.profile, ...args];
    return await new Promise((resolve) => {
      let output = '';
      let settled = false;
      let child;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        resolve({ code, output: output.slice(-6000) });
      };
      try {
        child = spawn(process.execPath, argv, {
          cwd: profileDir(),
          env: { ...process.env, CI: '1' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: -1, output: String((error && error.message) || error) });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(-2);
      }, timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { output += String(chunk); });
      child.stderr?.on('data', (chunk) => { output += String(chunk); });
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, output: String((error && error.message) || error) });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        finish(code ?? -1);
      });
    });
  }

  function registerBundle(pkgName) {
    if (!pkgName || pkgName.startsWith('@deepseek-ai/')) return false;
    const bundles = profileBundles();
    if (bundles.includes(pkgName)) return false;
    bundles.push(pkgName);
    setBundles(bundles);
    return true;
  }

  function unregisterBundle(pkgName) {
    const bundles = profileBundles();
    const next = bundles.filter((entry) => entry !== pkgName);
    if (next.length === bundles.length) return false;
    setBundles(next);
    return true;
  }

  async function installPackage(spec) {
    const args = ['add'];
    if (exists(path.join(profileDir(), 'pnpm-workspace.yaml'))) args.push('-w');
    args.push(spec);
    const result = await runPnpm(args);
    if (result.code !== 0) return { ok: false, output: result.output };
    const manifest = readProfileManifest();
    const deps = manifest && manifest.dependencies ? Object.keys(manifest.dependencies) : [];
    const guess = String(spec).split('#')[0].replace(/^.*\//, '').replace(/@[^@/]*$/, '');
    const installed = deps.find((dep) => dep === spec)
      || deps.find((dep) => dep.endsWith(guess))
      || guess;
    const real = packageManifest(installed) ? installed : guess;
    const registered = registerBundle(real);
    note({ action: 'install', target: real, spec });
    saveState();
    return { ok: true, installed: real, registered, output: result.output.slice(-1500) };
  }

  async function upgradePackage(pkgName) {
    const plugin = state().plugins.find((entry) => entry.name === pkgName);
    const target = plugin && plugin.latestCompatible ? plugin.latestCompatible : '';
    const result = await installPackage(target ? `${pkgName}@${target}` : pkgName);
    if (result.ok) note({ action: 'upgrade', target: pkgName });
    return result;
  }

  function suspendPackage(pkgName) {
    const current = state();
    const removed = unregisterBundle(pkgName);
    if (!current.suspended.includes(pkgName)) current.suspended.push(pkgName);
    current.pendingSuspend = current.pendingSuspend.filter((entry) => entry !== pkgName);
    note({ action: 'suspend', target: pkgName });
    saveState();
    return removed;
  }

  function resumePackage(pkgName) {
    const current = state();
    current.suspended = current.suspended.filter((entry) => entry !== pkgName);
    const added = registerBundle(pkgName);
    note({ action: 'resume', target: pkgName });
    saveState();
    return added;
  }

  /** Suspend every incompatible bundle right now (the offline repair path). */
  function fixIncompatible() {
    const snapshot = scan();
    const targets = snapshot.plugins
      .filter((plugin) => plugin.compat === 'incompatible' && plugin.bundled)
      .map((plugin) => plugin.name);
    const suspended = [];
    for (const target of targets) {
      if (suspendPackage(target)) suspended.push(target);
    }
    const missing = snapshot.plugins
      .filter((plugin) => plugin.compat === 'missing' && plugin.bundled)
      .map((plugin) => plugin.name);
    for (const target of missing) {
      if (unregisterBundle(target)) suspended.push(target);
    }
    note({ action: 'fix', targets: suspended });
    saveState();
    return { suspended, missing, runtime: snapshot.runtime };
  }

  /** Turn the automatic "suspend incompatible bundles on next boot" behaviour on/off. */
  function setAutoSuspend(value) {
    const current = state();
    current.autoSuspend = Boolean(value);
    scan(); // recompute pendingSuspend for the new setting
    note({ action: 'autosuspend', value: current.autoSuspend });
    saveState();
    return current.autoSuspend;
  }

  return {
    env,
    profileDir,
    statePath,
    runtimeVersion,
    scan,
    checkUpdates,
    installPackage,
    upgradePackage,
    suspendPackage,
    resumePackage,
    fixIncompatible,
    setAutoSuspend,
    state,
    saveState,
    note,
    profileBundles,
    packageManifest,
    readProfileManifest,
  };
}
