/**
 * Guardian 逻辑测试：用临时 DSH_HOME 造夹具，不碰真实 profile。
 * 运行： node test/doctor.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoctor, satisfies, unmetRequirements } from '../lib/doctor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeBin = process.env.GUARDIAN_RUNTIME_BIN
  || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function makeHome({ deps, bundles, packages }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-test-'));
  const profile = path.join(home, 'profiles', 'web');
  writeJson(path.join(profile, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles } },
  });
  for (const [name, manifest] of Object.entries(packages || {})) {
    writeJson(path.join(profile, 'node_modules', name, 'package.json'), manifest);
  }
  return home;
}

console.log(`guardian tests · runtime=${runtimeBin}`);
console.log(`runtime version = ${fs.existsSync(runtimeBin) ? 'found' : 'MISSING'}\n`);

// ---------------------------------------------------------------------------
console.log('1) 兼容性判定（与运行时同规则）');
check('rc.2 不满足 >=0.2.1-rc.3', satisfies('0.2.1-rc.2', '>=0.2.1-rc.3', runtimeBin) === false);
check('rc.2 满足 >=0.2.1-rc.2', satisfies('0.2.1-rc.2', '>=0.2.1-rc.2', runtimeBin) === true);
check('rc.2 满足 ^0.2.1-rc.1', satisfies('0.2.1-rc.2', '^0.2.1-rc.1', runtimeBin) === true);
check('rc.2 不满足 ^0.1.0-rc.6', satisfies('0.2.1-rc.2', '^0.1.0-rc.6', runtimeBin) === false);
check('通配 * 满足', satisfies('0.2.1-rc.2', '*', runtimeBin) === true);
check(
  'engines.dsh 优先于 peers',
  unmetRequirements({ engines: { dsh: '^9.0.0' }, peerDependencies: { '@deepseek-ai/dsh-tools': '*' } }, '0.2.1-rc.2', runtimeBin) !== null,
);
check(
  '非 dsh 的 peer 被忽略',
  unmetRequirements({ peerDependencies: { '@deepseek-ai/cordis': '^9.0.0' } }, '0.2.1-rc.2', runtimeBin) === null,
);

// ---------------------------------------------------------------------------
console.log('\n2) 体检：正常 / 不兼容 / 无 peer / 未安装');
const home = makeHome({
  deps: { 'ok-plugin': '1.0.0', 'bad-plugin': '1.0.0', 'missing-plugin': '1.0.0', '@deepseek-ai/dsh-extra': '1.0.0' },
  bundles: ['ok-plugin', 'bad-plugin', 'missing-plugin', '@deepseek-ai/dsh-extra'],
  packages: {
    'ok-plugin': { name: 'ok-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '*' } },
    'bad-plugin': { name: 'bad-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } },
  },
});
const doctor = createDoctor({ dshHome: home, profile: 'web', runtimeBin });
const snapshot = doctor.scan();
const byName = Object.fromEntries(snapshot.plugins.map((p) => [p.name, p]));
check('识别兼容插件', byName['ok-plugin']?.compat === 'ok', byName['ok-plugin']?.compat);
check('识别不兼容插件', byName['bad-plugin']?.compat === 'incompatible', byName['bad-plugin']?.compat);
check('识别未安装插件', byName['missing-plugin']?.compat === 'missing', byName['missing-plugin']?.compat);
check('官方 @deepseek-ai/* 不参与体检', byName['@deepseek-ai/dsh-extra'] === undefined);
check('默认（未开启自动停用）不写待停用清单', snapshot.pendingSuspend.length === 0, JSON.stringify(snapshot.pendingSuspend));
doctor.setAutoSuspend(true);
check(
  '开启自动停用后不兼容 bundle 进入清单',
  JSON.stringify(doctor.scan().pendingSuspend) === JSON.stringify(['bad-plugin']),
  JSON.stringify(doctor.scan().pendingSuspend),
);

// ---------------------------------------------------------------------------
console.log('\n3) 停用 / 恢复');
check('停用返回 true', doctor.suspendPackage('ok-plugin') === true);
check('停用后 bundle 被移除', !doctor.profileBundles().includes('ok-plugin'), JSON.stringify(doctor.profileBundles()));
check('停用记录在 state.suspended', doctor.state().suspended.includes('ok-plugin'));
check('重复停用返回 false', doctor.suspendPackage('ok-plugin') === false);
check('恢复返回 true', doctor.resumePackage('ok-plugin') === true);
check('恢复后 bundle 回来', doctor.profileBundles().includes('ok-plugin'));
check('恢复后 suspended 清空', !doctor.state().suspended.includes('ok-plugin'));

// ---------------------------------------------------------------------------
console.log('\n4) 离线修复：停用不兼容 + 未安装');
const fix = doctor.fixIncompatible();
check('修复报告包含不兼容项', fix.suspended.includes('bad-plugin'), JSON.stringify(fix));
check('修复报告包含未安装项', fix.suspended.includes('missing-plugin'), JSON.stringify(fix));
check('修复后不兼容项已移除', !doctor.profileBundles().includes('bad-plugin'));
check('修复后保留兼容项', doctor.profileBundles().includes('ok-plugin'));

// ---------------------------------------------------------------------------
console.log('\n5) 自动停用开关');
const autoHome = makeHome({
  deps: { 'bad-plugin': '1.0.0' },
  bundles: ['bad-plugin'],
  packages: { 'bad-plugin': { name: 'bad-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } } },
});
const autoDoctor = createDoctor({ dshHome: autoHome, profile: 'web', runtimeBin });
check('默认关闭，待停用为空', autoDoctor.scan().pendingSuspend.length === 0, JSON.stringify(autoDoctor.scan().pendingSuspend));
check('开启返回 true', autoDoctor.setAutoSuspend(true) === true);
check('开启后待停用非空', autoDoctor.scan().pendingSuspend.length === 1);
check('关闭后再次清空', autoDoctor.setAutoSuspend(false) === false && autoDoctor.scan().pendingSuspend.length === 0);

// ---------------------------------------------------------------------------
console.log('\n6) 坏数据容错');const statePath = doctor.statePath();
fs.writeFileSync(statePath, '{ this is not json', 'utf8');
const doctor2 = createDoctor({ dshHome: home, profile: 'web', runtimeBin });
let survived = true;
try {
  doctor2.scan();
} catch (error) {
  survived = false;
}
check('state.json 损坏时仍能体检', survived);
const rebuilt = doctor2.state();
check('损坏状态被重建（有 token）', typeof rebuilt.token === 'string' && rebuilt.token.length >= 16);

const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-empty-'));
const doctor3 = createDoctor({ dshHome: emptyHome, profile: 'web', runtimeBin });
let survivedEmpty = true;
try {
  const empty = doctor3.scan();
  survivedEmpty = empty.plugins.length === 0;
} catch {
  survivedEmpty = false;
}
check('没有 profile 时不崩溃', survivedEmpty);

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
