'use strict';

/**
 * Optional bridge for Electron shells (Bigfish and friends).
 *
 * A plugin cannot help when the harness itself will not boot, so the shell has
 * to own three things:
 *
 *   1. apply the pending-suspend list BEFORE spawning the backend;
 *   2. run `dsh-guardian fix` from a boot-failure page (offline repair);
 *   3. open the panel window with the token from guardian's state file.
 *
 * This module is dependency-free and safe to require from an Electron main
 * process. Wire it like this:
 *
 *   const createGuardianBridge = require('./guardian-bridge');
 *   const guardian = createGuardianBridge({
 *     profileDir,                   // <DSH_HOME>/profiles/web
 *     dshHome,                      // <DSH_HOME>
 *     runtimeBin,                   // newest dsh lib/bin.js
 *     nodeExe,                      // the node binary used to spawn the backend
 *     log: (text) => appendToBackendLog(text),
 *   });
 *
 *   // before `spawn(backend)`:
 *   await guardian.preflight();
 *
 *   // boot-failure page button:
 *   const result = await guardian.fix();
 *
 *   // tray menu item:
 *   const url = guardian.panelUrl(port);   // null when no state/token yet
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = function createGuardianBridge(options) {
  const {
    profileDir,
    dshHome,
    runtimeBin,
    nodeExe = process.execPath,
    runtimeVersion = () => '',
    log = () => {},
  } = options;

  const statePath = () => path.join(dshHome, 'guardian', 'state.json');
  const manifestPath = () => path.join(profileDir(), 'package.json');
  const cliPath = () => path.join(profileDir(), 'node_modules', 'dsh-plugin-guardian', 'bin', 'guardian.js');

  function readState() {
    return readJson(statePath(), null);
  }

  /** Remove the bundles guardian marked as incompatible and clear the list. */
  function applyPending() {
    try {
      const state = readState();
      const pending = state && Array.isArray(state.pendingSuspend)
        ? state.pendingSuspend.filter((name) => typeof name === 'string' && name.length > 0)
        : [];
      if (pending.length === 0) return [];
      const manifest = readJson(manifestPath(), null);
      const bundles = manifest && manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles;
      if (!Array.isArray(bundles)) return [];
      const next = bundles.filter((name) => !pending.includes(name));
      if (next.length === bundles.length) return [];
      manifest.dsh.profile.bundles = next;
      writeJsonAtomic(manifestPath(), manifest);
      state.pendingSuspend = [];
      writeJsonAtomic(statePath(), state);
      log(`guardian: suspended ${pending.join(', ')}`);
      return pending;
    } catch {
      return [];
    }
  }

  /** Offline repair: never needs the backend. */
  async function fix() {
    const cli = cliPath();
    if (!fs.existsSync(cli)) return { code: -1, output: 'dsh-plugin-guardian is not installed in this profile' };
    return await new Promise((resolve) => {
      let output = '';
      let child;
      try {
        child = spawn(nodeExe, [cli, 'fix', '--profile', path.basename(profileDir()), '--home', dshHome], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: -1, output: String((error && error.message) || error) });
        return;
      }
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { output += String(chunk); });
      child.stderr?.on('data', (chunk) => { output += String(chunk); });
      child.once('error', (error) => resolve({ code: -1, output: String((error && error.message) || error) }));
      child.once('close', (code) => {
        log(`guardian fix exit ${code}:\n${output}`);
        resolve({ code: code ?? -1, output });
      });
    });
  }

  /**
   * Call before spawning the backend. When the user turned auto-suspend off we
   * only apply what they already decided; otherwise a dsh version change
   * triggers a fresh offline grading pass.
   */
  async function preflight() {
    const state = readState();
    if (!state || state.autoSuspend === false) return applyPending();
    const version = runtimeVersion();
    if (version && state.runtime && state.runtime !== version) {
      const result = await fix();
      if (result.code === 0) return [];
    }
    return applyPending();
  }

  function panelUrl(port) {
    const state = readState();
    if (!port || !state || typeof state.token !== 'string') return null;
    return `http://127.0.0.1:${port}/guardian?t=${encodeURIComponent(state.token)}`;
  }

  return { statePath, readState, applyPending, fix, preflight, panelUrl };
};
