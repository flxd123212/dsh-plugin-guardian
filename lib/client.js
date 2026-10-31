window.__ModuleLoader__.load({
	id: "dsh-plugin-guardian",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		const h = React.createElement;

		// ------------------------------------------------------------------
		// Host bridge: same-origin fetch, the host accepts requests that carry
		// `Sec-Fetch-Site: same-origin` without the panel token.
		// ------------------------------------------------------------------
		const API = "/guardian/api";

		async function api(route, body) {
			const response = await fetch(API + route, {
				method: body === undefined ? "GET" : "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const data = await response.json().catch(() => ({ ok: false, error: "bad json" }));
			if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
			return data;
		}

		// ------------------------------------------------------------------
		// Styles: design tokens are defined on <body> by @deepseek-ai/dsh-client-ui-theme,
		// so these rules follow the settings dialog (and any active skin) automatically.
		// ------------------------------------------------------------------
		const CSS = `
.ga-root { display: flex; flex-direction: column; gap: 14px; }
.ga-head { display: flex; align-items: center; gap: 10px; }
.ga-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.ga-meta { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
.ga-spacer { flex: 1; }
.ga-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  overflow: hidden;
}
.ga-card-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
}
.ga-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 64px 64px auto auto;
  gap: 8px; align-items: center;
  padding: 9px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 13px;
}
.ga-row:first-of-type { border-top: 0; }
.ga-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.ga-name {
  font-family: var(--ds-font-family-code, Consolas, monospace);
  font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
}
.ga-ver { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.ga-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ga-chip {
  display: inline-flex; align-items: center;
  padding: 0 7px; border-radius: 999px;
  font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.ga-chip.ok { color: #22c55e; border-color: transparent; background: color-mix(in srgb, #22c55e 14%, transparent); }
.ga-chip.bad { color: var(--dsw-alias-state-error-primary, #f25a5a); border-color: transparent; background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 14%, transparent); }
.ga-chip.warn { color: #f7ad31; border-color: transparent; background: color-mix(in srgb, #f7ad31 14%, transparent); }
.ga-chip.muted { color: var(--dsw-alias-label-tertiary); }
.ga-btn {
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-primary);
  border-radius: 8px; padding: 3px 10px; font-size: 12px; line-height: 20px;
  font-family: inherit; cursor: pointer;
  transition: background .12s ease;
}
.ga-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.ga-btn.primary {
  background: var(--dsw-alias-button-info-fill, #4176e6);
  color: #fff;
  border-color: transparent; font-weight: 500;
}
body[data-ds-dark-theme] .ga-btn.primary { color: #0b1117; }
.ga-btn.primary:hover { background: var(--dsw-alias-button-info-hover, #7aaaff); }
.ga-btn:disabled { opacity: .45; cursor: default; }
.ga-textarea {
  width: 100%; min-height: 62px; resize: vertical;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  padding: 9px 11px; font: inherit; font-size: 12.5px; line-height: 1.6;
}
.ga-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.ga-textarea:focus { outline: none; border-color: var(--dsw-alias-label-tertiary); }
.ga-find { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.ga-result { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 9px 11px; }
.ga-result-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ga-result-name { font-family: var(--ds-font-family-code, Consolas, monospace); font-size: 12px; font-weight: 600; }
.ga-result-desc { margin: 3px 0 7px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ga-result-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ga-hint { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
.ga-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary);
  cursor: pointer; user-select: none; white-space: nowrap;
}
.ga-toggle input { accent-color: var(--dsw-alias-button-info-fill, #4176e6); margin: 0; }
.ga-error { color: var(--dsw-alias-state-error-primary, #f25a5a); font-size: 12px; white-space: pre-wrap; }
.ga-empty { padding: 18px 14px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
`;

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-guardian-styles")) return;
			const tag = document.createElement("style");
			tag.id = "dsh-guardian-styles";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------
		// UI
		// ------------------------------------------------------------------
		const chip = (text, cls) => h("span", { className: "ga-chip " + (cls || ""), key: text + (cls || "") }, text);

		function GuardianSection() {
			const [state, setState] = React.useState(null);
			const [error, setError] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [busy, setBusy] = React.useState("");
			const [query, setQuery] = React.useState("");
			const [results, setResults] = React.useState(null);
			const [finding, setFinding] = React.useState(false);
			const alive = React.useRef(true);

			React.useEffect(() => () => { alive.current = false; }, []);

			const load = React.useCallback(async () => {
				try {
					const data = await api("/state");
					if (!alive.current) return;
					setState(data.state);
					setError("");
				} catch (err) {
					if (alive.current) setError(String(err && err.message ? err.message : err));
				}
			}, []);

			React.useEffect(() => { load(); }, [load]);

			const run = React.useCallback(async (key, fn, done) => {
				setBusy(key);
				setNotice("");
				try {
					const data = await fn();
					if (!alive.current) return;
					if (data && data.state) setState(data.state);
					setNotice(done || "");
					setError("");
				} catch (err) {
					if (alive.current) setError(String(err && err.message ? err.message : err));
				} finally {
					if (alive.current) setBusy("");
				}
			}, []);

			const onCheck = () => run("check", () => api("/check", {}), "已是最新检查结果");
			const onAct = (act, name) => run(act + ":" + name, () => api("/" + act, { name }),
				(act === "upgrade" ? "升级" : act === "suspend" ? "停用" : "启用") + " " + name + " 完成，重启后生效");

			const onFind = async () => {
				const text = query.trim();
				if (!text) { setNotice("先写一句你想要的功能"); return; }
				setFinding(true);
				setResults(null);
				setNotice("");
				try {
					const data = await api("/search", { query: text });
					if (alive.current) setResults(data.results || []);
				} catch (err) {
					if (alive.current) setError(String(err && err.message ? err.message : err));
				} finally {
					if (alive.current) setFinding(false);
				}
			};

			const onInstall = async (spec) => {
				setFinding(true);
				setNotice("正在安装 " + spec + " …");
				try {
					const data = await api("/install", { spec });
					if (!alive.current) return;
					if (data.state) setState(data.state);
					setNotice(data.ok ? "已安装 " + spec + "，重启后生效" : "安装失败");
					if (!data.ok && data.result) setError(String(data.result.output || ""));
				} catch (err) {
					if (alive.current) setError(String(err && err.message ? err.message : err));
				} finally {
					if (alive.current) setFinding(false);
				}
			};

			if (!state) {
				return h("div", { className: "ga-root" },
					h("div", { className: "ga-head" }, h("h2", { className: "ga-title" }, "插件医生")),
					h("div", { className: "ga-card" }, h("div", { className: "ga-empty" }, error || "正在读取插件状态…")),
					error ? h("div", { className: "ga-error" }, error) : null);
			}

			const plugins = state.plugins || [];
			const rows = plugins.map((plugin) => {
				const chips = [];
				chips.push(plugin.compat === "ok" ? chip("兼容", "ok")
					: plugin.compat === "missing" ? chip("未安装", "warn")
						: chip("不兼容", "bad"));
				chips.push(plugin.bundled ? chip("启用", "muted") : chip("已停用", "warn"));
				if (plugin.update === "available") chips.push(chip("可更新", "ok"));
				if (plugin.update === "blocked") chips.push(chip("新版不兼容", "bad"));

				const actions = [];
				if (plugin.update === "available") {
					actions.push(h("button", {
						key: "upgrade",
						className: "ga-btn",
						disabled: busy !== "",
						onClick: () => onAct("upgrade", plugin.name),
					}, busy === "upgrade:" + plugin.name ? "升级中…" : "升级"));
				}
				actions.push(h("button", {
					key: "toggle",
					className: "ga-btn",
					disabled: busy !== "",
					onClick: () => onAct(plugin.bundled ? "suspend" : "resume", plugin.name),
				}, plugin.bundled ? "停用" : "启用"));

				return h("div", { className: "ga-row", key: plugin.name },
					h("span", { className: "ga-name", title: plugin.name }, plugin.name),
					h("span", { className: "ga-ver" }, plugin.installed || "—"),
					h("span", { className: "ga-ver" }, plugin.latest || "—"),
					h("span", { className: "ga-chips" }, chips),
					h("span", {}, actions));
			});

			const head = h("div", { className: "ga-head" },
				h("h2", { className: "ga-title" }, "插件医生"),
				h("span", { className: "ga-meta" },
					"dsh " + state.runtime + " · " + state.profile + " · " + plugins.length + " 个插件 / "
					+ plugins.filter((plugin) => plugin.bundled).length + " 个启用"),
				h("span", { className: "ga-spacer" }),
				h("label", {
					className: "ga-toggle",
					title: "不兼容的插件会在下次启动时自动停用（文件保留，可随时启用）",
				},
					h("input", {
						type: "checkbox",
						checked: state.autoSuspend !== false,
						disabled: busy !== "",
						onChange: (event) => {
							const value = event.target.checked;
							run("autosuspend", () => api("/autosuspend", { value }),
								value ? "已开启自动停用" : "已关闭自动停用");
						},
					}),
					"自动停用不兼容插件"),
				h("button", { className: "ga-btn primary", disabled: busy !== "", onClick: onCheck },
					busy === "check" ? "检查中…" : "检查更新"));

			const pending = state.pendingSuspend || [];
			const hint = pending.length
				? "下次启动会自动停用：" + pending.join("、")
				: state.checkedAt
					? "上次检查：" + new Date(state.checkedAt).toLocaleString()
					: "还没做过在线检查";

			const health = h("div", { className: "ga-card" },
				h("div", { className: "ga-card-head" }, hint),
				rows.length ? rows : h("div", { className: "ga-empty" }, "这个 profile 里还没有第三方插件"));

			const find = h("div", { className: "ga-card" },
				h("div", { className: "ga-card-head" }, "按需求找插件"),
				h("div", { className: "ga-find" },
					h("textarea", {
						className: "ga-textarea",
						placeholder: "比如：自动写周报、网页预览、换主题皮肤、定时任务…",
						value: query,
						onChange: (event) => setQuery(event.target.value),
					}),
					h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						h("button", { className: "ga-btn primary", disabled: finding, onClick: onFind },
							finding ? "搜索中…" : "搜索并匹配"),
						results ? h("span", { className: "ga-hint" }, "找到 " + results.length + " 个候选") : null),
					results && results.length === 0
						? h("div", { className: "ga-empty" }, "没找到匹配的插件，换个说法试试")
						: null,
					results ? results.map((entry) => {
						const badges = [];
						if (entry.compatible === true) badges.push(chip("兼容", "ok"));
						if (entry.compatible === false) badges.push(chip("不兼容", "bad"));
						badges.push(chip(entry.installed ? "已安装" : (entry.source || "npm"), entry.installed ? "warn" : "muted"));
						return h("div", { className: "ga-result", key: entry.name },
							h("div", { className: "ga-result-head" },
								h("span", { className: "ga-result-name" }, entry.name),
								entry.version ? h("span", { className: "ga-hint" }, entry.version) : null),
							h("p", { className: "ga-result-desc" }, entry.description || "（没有描述）"),
							entry.compatible === false && entry.unmet
								? h("p", { className: "ga-hint" },
									"需要：" + Object.entries(entry.unmet).map(([k, v]) => k + " " + v).join("；"))
								: null,
							h("div", { className: "ga-result-foot" }, badges,
								h("span", { className: "ga-spacer" }),
								entry.installed
									? h("button", { className: "ga-btn", disabled: true }, "已安装")
									: h("button", { className: "ga-btn primary", disabled: finding, onClick: () => onInstall(entry.installSpec || entry.name) }, "安装")));
					}) : null));

			return h("div", { className: "ga-root" },
				head,
				error ? h("div", { className: "ga-error" }, error) : null,
				notice ? h("div", { className: "ga-hint" }, notice) : null,
				health,
				find);
		}

		// ------------------------------------------------------------------
		// Plugin registration
		// ------------------------------------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("settings.section", () => {
				try {
					return ctx.slots.register({
						name: "settings.section",
						id: "guardian",
						order: 200,
						label: () => "插件医生",
					}, GuardianSection);
				} catch {
					return () => {};
				}
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-plugin-guardian-client";
		return module.exports;
	}
});
