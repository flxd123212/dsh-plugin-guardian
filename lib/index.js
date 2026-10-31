/**
 * dsh-plugin-guardian — the in-harness half: a doctor core (`doctor.js`) exposed
 * over `/guardian` HTTP + the `/guardian` slash command.
 *
 * The same core runs offline through `bin/guardian.js`, so a broken harness can
 * still be repaired: point the CLI at the profile and downgrade/suspend/upgrade
 * without booting the runtime. The desktop shell calls that CLI from its
 * boot-failure page.
 *
 * @module dsh-plugin-guardian
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDoctor, readText } from './doctor.js';
import { createSearch } from './search.js';

export const name = 'guardian';
export const inject = ['webServer', 'commands'];

function argvProfile() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile' && typeof argv[i + 1] === 'string') return argv[i + 1];
  }
  return 'web';
}

function panelFile() {
  try {
    return fileURLToPath(new URL('./panel.html', import.meta.url));
  } catch {
    return path.join(process.env.DSH_HOME || '', 'guardian', 'panel.html');
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function tokenFromRequest(req, url) {
  const query = url.searchParams.get('t');
  if (query) return query;
  const header = req.headers['x-guardian-token'];
  if (typeof header === 'string' && header) return header;
  const cookie = req.headers.cookie || '';
  const match = /(?:^|;\s*)guardian_token=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * The settings section (a client module of this same plugin) lives on the
 * harness origin, so it has no panel token. Browsers stamp the request with
 * `Sec-Fetch-Site: same-origin`, which a foreign page cannot forge — treat that
 * (plus a matching Origin/Referer) as authorisation.
 */
function isSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'same-origin') return true;
  const host = req.headers.host;
  if (!host) return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin === `http://${host}`) return true;
  const referer = req.headers.referer;
  if (typeof referer === 'string') {
    try {
      return new URL(referer).origin === `http://${host}`;
    } catch {
      return false;
    }
  }
  return false;
}

function authorized(req, url, doctor) {
  return tokenFromRequest(req, url) === doctor.state().token || isSameOrigin(req);
}

export function apply(ctx) {
  const doctor = createDoctor({
    profile: argvProfile(),
    runtimeBin: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
  });
  const search = createSearch(doctor);

  const log = (message) => {
    try {
      console.log(`[guardian] ${message}`);
    } catch {
      /* ignore */
    }
  };

  try {
    const snapshot = doctor.scan();
    const bad = snapshot.plugins.filter((plugin) => plugin.compat === 'incompatible');
    if (bad.length > 0) {
      log(`发现 ${bad.length} 个不兼容插件：${bad.map((plugin) => plugin.name).join(', ')}（重启后自动停用）`);
    }
  } catch (error) {
    log(`首次体检失败: ${(error && error.message) || error}`);
  }

  // Network-bound, so never on the boot path.
  setTimeout(() => {
    doctor.checkUpdates()
      .then((result) => {
        const available = result.plugins.filter((plugin) => plugin.update === 'available');
        if (available.length > 0) {
          log(`${available.length} 个插件有可用更新：${available.map((plugin) => plugin.name).join(', ')}`);
        }
      })
      .catch((error) => log(`更新检查失败: ${(error && error.message) || error}`));
  }, 4000).unref?.();

  const panelUrl = () => {
    const port = ctx.webServer && ctx.webServer.port ? ctx.webServer.port : 0;
    const host = ctx.webServer && ctx.webServer.host ? ctx.webServer.host : '127.0.0.1';
    return `http://${host}:${port}/guardian?t=${doctor.state().token}`;
  };

  // ---- routes -------------------------------------------------------------

  const disposePage = ctx.webServer.register({
    kind: 'exact',
    path: '/guardian',
    handler: (req, res) => {
      const url = new URL(req.url || '/guardian', 'http://guardian.local');
      const token = tokenFromRequest(req, url);
      if (token !== doctor.state().token) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<meta charset="utf-8"><body style="font-family:system-ui;background:#0b0b0f;color:#e8edf3;padding:40px">'
          + '<h2>需要面板令牌</h2><p>请从 <code>/guardian</code> 命令输出的链接进入。</p></body>');
        return;
      }
      const html = readText(panelFile());
      if (!html) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('guardian: panel.html 缺失');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `guardian_token=${encodeURIComponent(token)}; Path=/guardian; SameSite=Strict; HttpOnly`,
      });
      res.end(html);
    },
  });

  const disposeApi = ctx.webServer.register({
    kind: 'prefix',
    path: '/guardian/api',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://guardian.local');
      if (!authorized(req, url, doctor)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const route = url.pathname.slice('/guardian/api'.length) || '/';
      const method = req.method || 'GET';
      try {
        if (route === '/state' && method === 'GET') {
          sendJson(res, 200, { ok: true, state: doctor.scan() });
          return;
        }
        if (route === '/check' && method === 'POST') {
          sendJson(res, 200, { ok: true, state: await doctor.checkUpdates() });
          return;
        }
        if (route === '/suspend' && method === 'POST') {
          const body = await readBody(req);
          const target = String(body.name || '');
          if (!target) { sendJson(res, 400, { ok: false, error: '缺少 name' }); return; }
          const removed = doctor.suspendPackage(target);
          sendJson(res, 200, { ok: true, removed, state: doctor.scan() });
          return;
        }
        if (route === '/resume' && method === 'POST') {
          const body = await readBody(req);
          const target = String(body.name || '');
          if (!target) { sendJson(res, 400, { ok: false, error: '缺少 name' }); return; }
          const added = doctor.resumePackage(target);
          sendJson(res, 200, { ok: true, added, state: doctor.scan() });
          return;
        }
        if (route === '/autosuspend' && method === 'POST') {
          const body = await readBody(req);
          const value = doctor.setAutoSuspend(Boolean(body.value));
          sendJson(res, 200, { ok: true, autoSuspend: value, state: doctor.scan() });
          return;
        }
        if (route === '/upgrade' && method === 'POST') {
          const body = await readBody(req);
          const target = String(body.name || '');
          if (!target) { sendJson(res, 400, { ok: false, error: '缺少 name' }); return; }
          const result = await doctor.upgradePackage(target);
          await doctor.checkUpdates();
          sendJson(res, 200, { ok: result.ok, result, state: doctor.scan() });
          return;
        }
        if (route === '/install' && method === 'POST') {
          const body = await readBody(req);
          const spec = String(body.spec || '').trim();
          if (!spec) { sendJson(res, 400, { ok: false, error: '缺少 spec' }); return; }
          const result = await doctor.installPackage(spec);
          await doctor.checkUpdates();
          sendJson(res, 200, { ok: result.ok, result, state: doctor.scan() });
          return;
        }
        if (route === '/search' && method === 'POST') {
          const body = await readBody(req);
          const query = String(body.query || '').trim();
          if (!query) { sendJson(res, 400, { ok: false, error: '说说你想要什么功能' }); return; }
          sendJson(res, 200, { ok: true, query, results: await search(query) });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
      }
    },
  });

  ctx.effect(() => () => {
    try { disposePage(); } catch { /* ignore */ }
    try { disposeApi(); } catch { /* ignore */ }
  }, 'guardian: routes');

  // ---- slash command ------------------------------------------------------

  const statusReport = () => {
    const snapshot = doctor.scan();
    const lines = [];
    const bad = snapshot.plugins.filter((plugin) => plugin.compat === 'incompatible');
    const missing = snapshot.plugins.filter((plugin) => plugin.compat === 'missing');
    const updates = snapshot.plugins.filter((plugin) => plugin.update === 'available');
    const blocked = snapshot.plugins.filter((plugin) => plugin.update === 'blocked');
    lines.push(`**插件体检** · dsh ${snapshot.runtime} · profile \`${snapshot.profile}\``);
    lines.push(`已装 ${snapshot.plugins.length} 个，启用 ${snapshot.plugins.filter((plugin) => plugin.bundled).length} 个。`);
    if (bad.length > 0) {
      lines.push('');
      lines.push(`⚠️ 不兼容 ${bad.length} 个（重启后会被暂停）：`);
      for (const plugin of bad) {
        const why = Object.entries(plugin.unmet || {}).map(([dep, range]) => `${dep} ${range}`).join('；');
        lines.push(`- \`${plugin.name}\` ${plugin.installed} — ${why}`);
      }
    }
    if (updates.length > 0) {
      lines.push('');
      lines.push(`⬆️ 有可用更新 ${updates.length} 个：`);
      for (const plugin of updates) {
        lines.push(`- \`${plugin.name}\` ${plugin.installed} → ${plugin.latestCompatible || plugin.latest}`);
      }
    }
    if (blocked.length > 0) {
      lines.push('');
      lines.push(`⏸ 新版本已不兼容，先别升 ${blocked.length} 个：`);
      for (const plugin of blocked) {
        lines.push(`- \`${plugin.name}\` ${plugin.installed}（最新 ${plugin.latest}）`);
      }
    }
    if (missing.length > 0) {
      lines.push('');
      lines.push(`❓ 注册了但没装 ${missing.length} 个：${missing.map((plugin) => plugin.name).join('、')}`);
    }
    if (snapshot.checkedAt === 0) {
      lines.push('');
      lines.push('（还没做过在线检查，打开面板点「检查更新」）');
    }
    lines.push('');
    lines.push(`面板：${panelUrl()}`);
    return lines.join('\n');
  };

  const findReport = async (query) => {
    const results = await search(query);
    if (results.length === 0) {
      return `没有找到和「${query}」相关的插件。换个说法试试（比如「终端」「网页预览」「主题皮肤」）。`;
    }
    const lines = [`**找到 ${results.length} 个候选**（按相关度）：`];
    for (const entry of results.slice(0, 6)) {
      const badge = entry.compatible === false ? ' ❌不兼容' : entry.compatible === true ? ' ✅' : '';
      const action = entry.source === 'github'
        ? `仓库：${entry.repo || entry.name}`
        : `安装：\`/guardian install ${entry.name}\``;
      lines.push(`- \`${entry.name}\`${entry.version ? ` ${entry.version}` : ''}${badge} — ${entry.description || '（无描述）'}\n  ${action}`);
    }
    lines.push('');
    lines.push(`面板（可一键安装）：${panelUrl()}`);
    return lines.join('\n');
  };

  ctx.commands.register({
    definitionId: 'dsh-plugin-guardian',
    name: 'guardian',
    description: '插件体检：兼容性 / 更新 / 停用恢复，按需求搜索并安装社区插件',
    input: { hint: '[check|find <你想要的功能>|install <包名>|suspend <包名>|resume <包名>]' },
    handler: async (invocation) => {
      const raw = String(invocation.rawInput || '').trim();
      if (raw.length === 0) return { text: statusReport() };
      const [verb, ...rest] = raw.split(/\s+/);
      const arg = rest.join(' ').trim();
      if (verb === 'check' || verb === '更新') {
        const result = await doctor.checkUpdates();
        const updates = result.plugins.filter((plugin) => plugin.update === 'available');
        return { text: updates.length > 0
          ? `检查完成：${updates.length} 个插件可更新\n${updates.map((plugin) => `- \`${plugin.name}\` ${plugin.installed} → ${plugin.latestCompatible}`).join('\n')}`
          : `检查完成：没有可用更新。\n面板：${panelUrl()}` };
      }
      if (verb === 'find' || verb === 'search' || verb === '找') {
        return { text: await findReport(arg || raw) };
      }
      if (verb === 'install' && arg) {
        const result = await doctor.installPackage(arg);
        return { text: result.ok
          ? `已安装 \`${result.installed}\`${result.registered ? '，已加入启用列表' : ''}。\n重启 profile 后生效。\n${result.output}`
          : `安装失败：\n${result.output}` };
      }
      if (verb === 'suspend' && arg) {
        return { text: doctor.suspendPackage(arg) ? `已停用 \`${arg}\`（重启后生效）` : `\`${arg}\` 本来就没启用` };
      }
      if (verb === 'resume' && arg) {
        return { text: doctor.resumePackage(arg) ? `已重新启用 \`${arg}\`（重启后生效）` : `\`${arg}\` 已经在启用列表里` };
      }
      return {
        text: `用法：\`/guardian\` 查看体检；\`/guardian find 自动写周报\` 找插件；\`/guardian install <包名>\` 安装。\n面板：${panelUrl()}`,
      };
    },
  });

  log(`就绪 · dsh ${doctor.runtimeVersion()} · profile ${doctor.env.profile} · 面板 /guardian`);
}
