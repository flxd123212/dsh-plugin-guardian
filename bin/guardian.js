#!/usr/bin/env node
/**
 * dsh-guardian — offline repair CLI.
 *
 * Runs with plain Node and never boots the harness, so it still works when the
 * web profile cannot start (bad plugin, version skew, half-finished upgrade).
 * The in-harness plugin and the desktop shell's boot-failure page both call
 * this same code path.
 *
 *   dsh-guardian doctor                体检（离线，不发网络请求）
 *   dsh-guardian check                 联网检查更新
 *   dsh-guardian fix                   停用所有不兼容/未安装的插件（离线修复）
 *   dsh-guardian suspend <包名>
 *   dsh-guardian resume <包名>
 *   dsh-guardian upgrade <包名>
 *   dsh-guardian upgrade-all
 *   dsh-guardian install <spec>
 *   dsh-guardian find <需求>
 *   dsh-guardian where
 *
 * Options: --profile <name> (default web) · --home <DSH_HOME> · --runtime <bin.js>
 *          --json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDoctor } from '../lib/doctor.js';
import { createSearch } from '../lib/search.js';

function parseArgs(argv) {
  const options = { profile: 'web', home: undefined, runtime: undefined, json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') { options.json = true; continue; }
    if (token === '--profile' && argv[i + 1]) { options.profile = argv[i + 1]; i += 1; continue; }
    if (token === '--home' && argv[i + 1]) { options.home = argv[i + 1]; i += 1; continue; }
    if (token === '--runtime' && argv[i + 1]) { options.runtime = argv[i + 1]; i += 1; continue; }
    if (token === '-h' || token === '--help') { options.help = true; continue; }
    positional.push(token);
  }
  return { command: positional[0] || 'doctor', args: positional.slice(1), options };
}

const HELP = `dsh-guardian — DSH 插件医生（可离线运行）

  dsh-guardian doctor                 体检：兼容性 / 启用状态 / 待停用
  dsh-guardian check                  联网检查可用更新
  dsh-guardian fix                    停用所有不兼容或未安装的插件
  dsh-guardian suspend <包名>         停用一个插件
  dsh-guardian resume <包名>          重新启用一个插件
  dsh-guardian upgrade <包名>         升级到最新兼容版本
  dsh-guardian upgrade-all            升级所有可更新的插件
  dsh-guardian install <spec>         安装并启用（npm / github:）
  dsh-guardian find <需求>            按需求搜索插件
  dsh-guardian autosuspend on|off     自动停用不兼容插件（默认 on）
  dsh-guardian where                  打印检测到的路径和版本

选项：--profile <名称>（默认 web） --home <DSH_HOME> --runtime <bin.js> --json
`;

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function shortWhy(plugin) {
  const entries = Object.entries(plugin.unmet || {});
  if (entries.length === 0) return '';
  return entries.map(([dep, range]) => `${dep} ${range}`).join('；');
}

function printDoctor(doctor, snapshot) {
  const bad = snapshot.plugins.filter((plugin) => plugin.compat === 'incompatible');
  const missing = snapshot.plugins.filter((plugin) => plugin.compat === 'missing');
  const updates = snapshot.plugins.filter((plugin) => plugin.update === 'available');
  line(`dsh ${snapshot.runtime} · profile ${snapshot.profile}`);
  line(`已装 ${snapshot.plugins.length} 个，启用 ${snapshot.plugins.filter((plugin) => plugin.bundled).length} 个`);
  line();
  for (const plugin of snapshot.plugins) {
    const flags = [
      plugin.bundled ? '启用' : '停用',
      plugin.compat === 'ok' ? '兼容' : plugin.compat === 'missing' ? '未安装' : '不兼容',
    ];
    if (plugin.update === 'available') flags.push(`可更新→${plugin.latestCompatible || plugin.latest}`);
    if (plugin.update === 'blocked') flags.push(`新版不兼容(${plugin.latest})`);
    const why = plugin.compat === 'incompatible' ? `  ← ${shortWhy(plugin)}` : '';
    line(`  ${plugin.name.padEnd(38)} ${String(plugin.installed || '—').padEnd(14)} ${flags.join(' / ')}${why}`);
  }
  if (bad.length > 0 || missing.length > 0) {
    line();
    line(`需要处理：${[...bad, ...missing].map((plugin) => plugin.name).join('、')}`);
    line('运行 `dsh-guardian fix` 可停用它们（插件文件保留，随时 `resume`）。');
  }
  if (updates.length > 0) {
    line();
    line(`可更新：${updates.map((plugin) => `${plugin.name}→${plugin.latestCompatible}`).join('、')}`);
    line('运行 `dsh-guardian upgrade-all` 升级到最新兼容版本。');
  }
  if (snapshot.pendingSuspend && snapshot.pendingSuspend.length > 0) {
    line();
    line(`下次启动将自动停用：${snapshot.pendingSuspend.join('、')}`);
  }
}

async function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2));
  if (options.help) { line(HELP); return 0; }

  const doctor = createDoctor({
    profile: options.profile,
    dshHome: options.home,
    runtimeBin: options.runtime,
  });
  const json = (value) => line(JSON.stringify(value, null, 2));

  switch (command) {
    case 'where': {
      const payload = {
        dshHome: doctor.env.dshHome,
        profile: doctor.env.profile,
        profileDir: doctor.profileDir(),
        runtimeBin: doctor.env.runtimeBin || null,
        runtime: doctor.runtimeVersion(),
        state: doctor.statePath(),
      };
      if (options.json) json(payload);
      else {
        line(`DSH_HOME   ${payload.dshHome}`);
        line(`profile    ${payload.profile}  (${payload.profileDir})`);
        line(`runtime    ${payload.runtime}  ${payload.runtimeBin || '（未找到 dsh，可加 --runtime）'}`);
        line(`state      ${payload.state}`);
      }
      return 0;
    }
    case 'doctor': {
      const snapshot = doctor.scan();
      if (options.json) json(snapshot);
      else printDoctor(doctor, snapshot);
      return 0;
    }
    case 'check': {
      const snapshot = await doctor.checkUpdates();
      if (options.json) { json(snapshot); return 0; }
      printDoctor(doctor, snapshot);
      const updates = snapshot.plugins.filter((plugin) => plugin.update === 'available');
      if (updates.length === 0) line('\n没有可用更新。');
      return 0;
    }
    case 'fix': {
      const result = doctor.fixIncompatible();
      if (options.json) json(result);
      else if (result.suspended.length === 0) line('没有需要停用的插件，配置是干净的。');
      else {
        line(`已停用 ${result.suspended.length} 个插件（文件保留，可随时 resume）：`);
        for (const name of result.suspended) line(`  - ${name}`);
        line('\n重启 harness / 重新打开 Bigfish 后生效。');
      }
      return 0;
    }
    case 'suspend': {
      if (!args[0]) { line('用法：dsh-guardian suspend <包名>'); return 1; }
      const removed = doctor.suspendPackage(args[0]);
      line(removed ? `已停用 ${args[0]}` : `${args[0]} 本来就没启用`);
      return 0;
    }
    case 'resume': {
      if (!args[0]) { line('用法：dsh-guardian resume <包名>'); return 1; }
      const added = doctor.resumePackage(args[0]);
      line(added ? `已启用 ${args[0]}` : `${args[0]} 已经在启用列表里`);
      return 0;
    }
    case 'autosuspend': {
      const value = String(args[0] || '').toLowerCase();
      if (!['on', 'off', 'true', 'false', '1', '0'].includes(value)) {
        line('用法：dsh-guardian autosuspend on|off');
        return 1;
      }
      const enabled = doctor.setAutoSuspend(['on', 'true', '1'].includes(value));
      line(enabled
        ? '已开启：不兼容的插件会在下次启动时自动停用（文件保留，可 resume）'
        : '已关闭：启动时不会自动改动插件配置');
      return 0;
    }
    case 'upgrade': {
      if (!args[0]) { line('用法：dsh-guardian upgrade <包名>'); return 1; }
      await doctor.checkUpdates();
      const result = await doctor.upgradePackage(args[0]);
      line(result.ok ? `已升级 ${args[0]}${result.registered ? '（已加入启用列表）' : ''}` : `升级失败：\n${result.output}`);
      return result.ok ? 0 : 1;
    }
    case 'upgrade-all': {
      const snapshot = await doctor.checkUpdates();
      const targets = snapshot.plugins.filter((plugin) => plugin.update === 'available');
      if (targets.length === 0) { line('没有可更新的插件。'); return 0; }
      let failed = 0;
      for (const plugin of targets) {
        const result = await doctor.upgradePackage(plugin.name);
        if (result.ok) line(`✓ ${plugin.name} → ${plugin.latestCompatible || 'latest'}`);
        else { failed += 1; line(`✗ ${plugin.name}: ${result.output.split('\n').slice(-3).join(' ')}`); }
      }
      line(failed === 0 ? '\n全部完成，重启后生效。' : `\n${failed} 个升级失败。`);
      return failed === 0 ? 0 : 1;
    }
    case 'install': {
      if (!args[0]) { line('用法：dsh-guardian install <包名或 github:user/repo>'); return 1; }
      const result = await doctor.installPackage(args[0]);
      line(result.ok ? `已安装 ${result.installed}` : `安装失败：\n${result.output}`);
      return result.ok ? 0 : 1;
    }
    case 'find': {
      const query = args.join(' ').trim();
      if (!query) { line('用法：dsh-guardian find <你想要的功能>'); return 1; }
      const search = createSearch(doctor);
      const results = await search(query);
      if (options.json) { json(results); return 0; }
      if (results.length === 0) { line('没找到匹配的插件。'); return 1; }
      for (const entry of results) {
        const badge = entry.compatible === false ? ' [不兼容]' : entry.compatible === true ? ' [兼容]' : '';
        line(`  ${entry.name}${entry.version ? ' ' + entry.version : ''}${badge} — ${entry.description || '(无描述)'}`);
      }
      line('\n安装：dsh-guardian install <包名>');
      return 0;
    }
    default:
      line(`未知命令：${command}\n`);
      line(HELP);
      return 1;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`guardian 失败：${(error && error.message) || error}\n`);
    process.exitCode = 1;
  });
