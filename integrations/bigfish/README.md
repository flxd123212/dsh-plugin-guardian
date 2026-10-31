# Desktop-shell integration (optional)

Guardian is fully usable on its own: settings section, `/guardian` command,
`dsh-guardian` CLI. An Electron shell can add three things that a plugin cannot
do, because they must happen **before the harness boots** (or when it refuses
to):

1. apply guardian's pending-suspend list before spawning the backend;
2. offer an offline "repair" button on the boot-failure page;
3. open the panel window with the token from guardian's state file.

`guardian-bridge.js` in this folder implements all three with no dependencies.
Copy it next to your `main.js` and wire it as below.

## 1. Create the bridge

```js
const createGuardianBridge = require('./guardian-bridge');

const guardian = createGuardianBridge({
  profileDir: () => path.join(dshHome(), 'profiles', 'web'),
  dshHome: dshHome(),
  runtimeBin: pickDshEntry().bin,          // newest installed dsh
  nodeExe: path.join(process.resourcesPath, 'node-runtime', 'node.exe'),
  runtimeVersion: () => pickDshEntry().version,
  log: (text) => writeBackendLog(text),
});
```

## 2. Call `preflight()` before spawning the backend

```js
async function startDsh() {
  openBackendLog();
  cleanupStaleDsh();
  await guardian.preflight();      // ← suspends what cannot boot this runtime
  sanitizeProfileBundles();
  // …spawn…
}
```

With auto-suspend enabled, a dsh upgrade triggers an offline re-grading pass and
the bundles that no longer load are removed before the new runtime starts. With
it disabled, `preflight()` only applies what the user already decided.

## 3. Boot-failure page button

```js
ipcMain.on('boot:guardian-fix', async () => {
  showBootError('Running the plugin doctor…');
  const result = await guardian.fix();
  if (result.code === 0) recoverBackend('guardian repaired the profile');
  else showBootError(result.output);
});
```

Expose it in the preload (`contextBridge.exposeInMainWorld`) and call it from the
error page. `fix()` runs `dsh-guardian fix`, which never loads the harness.

## 4. Panel window

```js
const url = guardian.panelUrl(port);
if (url) new BrowserWindow({ width: 1020, height: 760 }).loadURL(url);
```

The page sets an `HttpOnly` cookie for `/guardian`, so subsequent API calls need
no token.

## Notes

- `preflight()` is idempotent and cheap when there is nothing to do (one JSON
  read).
- All writes are atomic (`tmp` + rename) so a crash cannot leave a half-written
  profile manifest.
- The bridge never touches `node_modules`, credentials, sessions or settings.
