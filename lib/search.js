/**
 * Guardian discovery — free text intent → ranked plugin candidates from the
 * community registry, the npm search API, and (when reachable) GitHub.
 */

import { fetchJson, npmLatest, unmetRequirements, mapLimit } from './doctor.js';

const COMMUNITY_REGISTRY = 'https://awesome-dsh-plugin.com/plugins.json';
const COMMUNITY_MIRROR = 'https://cdn.jsdelivr.net/gh/turtle2209/Bigfish@main/plugins.json';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'and', 'or', 'with', 'my', 'me', 'i', 'want', 'need', 'please',
  '的', '了', '我', '要', '想', '一个', '插件', '功能', '能', '可以', '帮我', '需要', '有没有', '找', '个',
]);

/**
 * Chinese intents rarely appear in npm/GitHub metadata, so map the common ones
 * onto the English keywords the ecosystem actually uses.
 */
const INTENT_SYNONYMS = {
  周报: ['report', 'weekly', 'summary'],
  日报: ['report', 'daily'],
  月报: ['report', 'monthly'],
  报告: ['report'],
  总结: ['summary', 'report'],
  预览: ['preview'],
  终端: ['terminal', 'shell'],
  命令行: ['terminal', 'shell', 'cli'],
  皮肤: ['theme', 'skin'],
  主题: ['theme', 'skin'],
  外观: ['theme', 'ui'],
  定时: ['schedule', 'cron', 'timer'],
  计划: ['schedule', 'plan'],
  待办: ['todo', 'task'],
  任务: ['task', 'todo', 'job'],
  看板: ['board', 'task'],
  翻译: ['translate', 'translation'],
  语音: ['voice', 'speech', 'audio'],
  朗读: ['speech', 'tts', 'voice'],
  图片: ['image', 'vision', 'picture'],
  图像: ['image', 'vision'],
  识图: ['image', 'vision', 'describe'],
  截图: ['screenshot', 'capture'],
  浏览器: ['browser', 'web'],
  网页: ['web', 'browser', 'preview'],
  搜索: ['search', 'web'],
  联网: ['web', 'search', 'fetch'],
  笔记: ['note', 'notes'],
  备忘录: ['note', 'memo'],
  文档: ['document', 'doc', 'office'],
  表格: ['excel', 'sheet', 'table'],
  幻灯片: ['ppt', 'slide', 'presentation'],
  演示: ['presentation', 'slide'],
  数据库: ['database', 'sql', 'postgres'],
  图表: ['chart', 'graph', 'diagram'],
  画图: ['draw', 'canvas', 'diagram'],
  测试: ['test', 'testing'],
  部署: ['deploy', 'deployment'],
  通知: ['notify', 'notification'],
  提醒: ['remind', 'notification'],
  记忆: ['memory'],
  知识库: ['knowledge', 'rag', 'docs'],
  监控: ['monitor', 'metrics'],
  日志: ['log', 'logs'],
  代理: ['agent', 'proxy'],
  视频: ['video'],
  音频: ['audio'],
  音乐: ['music', 'audio'],
  代码: ['code'],
  审查: ['review', 'lint'],
  格式化: ['format', 'prettier'],
  手机: ['mobile', 'ios', 'android'],
  远程: ['remote'],
  同步: ['sync'],
  备份: ['backup', 'archive'],
  归档: ['archive'],
  文件夹: ['file', 'folder'],
  文件: ['file'],
  状态栏: ['status', 'bar'],
};

export function expandIntent(query) {
  const text = String(query || '').toLowerCase();
  const out = [];
  for (const [zh, words] of Object.entries(INTENT_SYNONYMS)) {
    if (text.includes(zh)) out.push(...words);
  }
  return [...new Set(out)];
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function scoreEntry(tokens, entry) {
  const haystack = [entry.name, entry.description, ...(entry.keywords || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 3 : 2;
  }
  if (/\b(dsh|deepseek)\b/.test(haystack)) score += 1;
  if (entry.installed) score += 1;
  return score;
}

function guessRepoUrl(entry) {
  const repo = entry.repository && (entry.repository.url || entry.repository);
  if (typeof repo === 'string' && repo.length > 0) return repo.replace(/^git\+/, '').replace(/\.git$/, '');
  return entry.homepage || entry.url || '';
}

function normalizeCommunityEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pkgName = raw.name || raw.package || raw.id || raw.npm;
  if (typeof pkgName !== 'string' || pkgName.length === 0) return null;
  if (pkgName.startsWith('@deepseek-ai/')) return null;
  const entry = {
    name: pkgName,
    description: String(raw.description || raw.desc || ''),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String) : [],
    version: String(raw.version || ''),
    source: 'community',
    installSpec: pkgName,
    repo: guessRepoUrl(raw),
  };
  if (raw.github || raw.repo) entry.repo = String(raw.github || raw.repo);
  if (raw.install) entry.installSpec = String(raw.install);
  return entry;
}

async function communityCatalog() {
  for (const url of [COMMUNITY_REGISTRY, COMMUNITY_MIRROR]) {
    const data = await fetchJson(url, 5000);
    if (!data) continue;
    const list = Array.isArray(data) ? data : Array.isArray(data.plugins) ? data.plugins : [];
    if (list.length > 0) return list.map(normalizeCommunityEntry).filter(Boolean);
  }
  return [];
}

async function npmSearch(query) {
  const words = tokenize(query).slice(0, 3);
  const text = ['dsh', ...words].join(' ');
  const data = await fetchJson(
    `https://registry.npmmirror.com/-/v1/search?text=${encodeURIComponent(text)}&size=20`,
    4500,
  );
  const objects = data && Array.isArray(data.objects) ? data.objects : [];
  const out = [];
  for (const item of objects) {
    const pkg = item && item.package;
    if (!pkg || typeof pkg.name !== 'string') continue;
    if (pkg.name.startsWith('@deepseek-ai/')) continue;
    const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [];
    const isDsh = /\bdsh\b/i.test(pkg.name)
      || /dsh|deepseek/i.test(`${pkg.name} ${pkg.description || ''} ${keywords.join(' ')}`);
    if (!isDsh) continue;
    out.push({
      name: pkg.name,
      description: String(pkg.description || ''),
      keywords,
      version: String(pkg.version || ''),
      source: 'npm',
      installSpec: pkg.name,
      repo: guessRepoUrl(pkg),
    });
  }
  return out;
}

async function githubSearch(query) {
  const data = await fetchJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} dsh`)}&per_page=10&sort=stars`,
    3000,
  );
  const items = data && Array.isArray(data.items) ? data.items : [];
  return items
    .map((item) => ({
      name: item.full_name,
      description: String(item.description || ''),
      keywords: Array.isArray(item.topics) ? item.topics.map(String) : [],
      version: '',
      source: 'github',
      installSpec: `github:${item.full_name}`,
      repo: item.html_url,
      stars: item.stargazers_count,
    }))
    // GitHub 的搜索很宽泛，只留下看起来真是 DSH 插件的仓库，避免推荐一堆无关项目
    .filter((entry) => {
      const name = String(entry.name).toLowerCase();
      const text = `${entry.description} ${(entry.keywords || []).join(' ')}`.toLowerCase();
      return name.includes('dsh') && /(plugin|extension|插件|tool|skill|agent)/.test(text);
    })
    .slice(0, 6);
}

/**
 * @param {ReturnType<import('./doctor.js').createDoctor>} doctor
 * @returns {(query: string) => Promise<Array<object>>}
 */
export function createSearch(doctor) {
  return async function searchCandidates(query) {
    const tokens = [...new Set([...tokenize(query), ...expandIntent(query)])];
    if (tokens.length === 0) return [];
    const english = [...new Set([
      ...expandIntent(query).slice(0, 3),
      ...tokens.filter((token) => /^[a-z0-9-]+$/.test(token)).slice(0, 3),
    ])];
    const npmQueries = [...new Set([query, ...english])].slice(0, 3);

    const [community, npmLists, githubHits] = await Promise.all([
      communityCatalog(),
      Promise.all(npmQueries.map((text) => npmSearch(text))),
      githubSearch(english.join(' ') || query),
    ]);

    const merged = new Map();
    const add = (entry) => {
      if (!entry || !entry.name) return;
      const key = String(entry.name).toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        existing.keywords = [...new Set([...(existing.keywords || []), ...(entry.keywords || [])])];
        if (!existing.version && entry.version) existing.version = entry.version;
        return;
      }
      merged.set(key, { ...entry });
    };
    for (const entry of community) add(entry);
    for (const list of npmLists) for (const entry of list) add(entry);
    for (const entry of githubHits) add(entry);

    const installed = new Set(doctor.state().plugins.map((plugin) => plugin.name));
    const bundles = new Set(doctor.profileBundles());
    const runtime = doctor.runtimeVersion();

    const ranked = [...merged.values()]
      .map((entry) => ({ ...entry, score: scoreEntry(tokens, entry) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    await mapLimit(ranked.filter((entry) => entry.source !== 'github').slice(0, 8), 4, async (entry) => {
      const manifest = await npmLatest(entry.name);
      if (!manifest) return;
      entry.version = String(manifest.version || entry.version || '');
      const unmet = unmetRequirements(
        { engines: manifest.engines, peerDependencies: manifest.peerDependencies },
        runtime,
        doctor.env.runtimeBin,
      );
      entry.compatible = !unmet;
      if (unmet) entry.unmet = unmet;
    });

    for (const entry of ranked) {
      entry.installed = installed.has(entry.name);
      entry.bundled = bundles.has(entry.name);
    }
    return ranked;
  };
}
