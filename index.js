(function () {
    "use strict";
    try { vendetta.ui.toasts.showToast("ClickableRoles: evaluating"); } catch (e) { }

    function build() {
    /*
     * ClickableRoles for Revenge Classic
     * Port of the Equicord/Vencord ClickableRoles plugin by prism.
     * SPDX-License-Identifier: GPL-3.0-or-later
     */

    const BUILD = "debug-10";

    const { metro, patcher, ui, logger } = vendetta;
    const storage = vendetta.plugin && vendetta.plugin.storage;
    let prevLog = [];
    try { if (storage && storage.log) prevLog = Array.from(storage.log); } catch (e) { }
    const { findByProps, findByName, findByStoreName } = metro;
    const { React, ReactNative: RN } = metro.common;
    const { Forms } = ui.components;
    const h = React.createElement;

    const MAX_VISIBLE_MEMBERS = 20;
    const CACHE_TTL = 60000;
    const MAX_LOG_LINES = 500;
    const VERBOSE_RENDERS = 8;

    // Components to hook. mode "pill": wrap the component's own output.
    // mode "tree": walk the rendered element tree and wrap any child that carries a role.
    // mode "observe": only log props and the rendered tree, to learn how it works.
    const TARGETS = [
        { name: "RolePill", mode: "pill" },
        { name: "UserProfileRolesCard", mode: "tree" },
        { name: "MemberRolesList", mode: "tree" },
        { name: "StandaloneMembersView", mode: "members" },
        { name: "GuildChannelMemberRow", mode: "observe" },
        { name: "RoleMembersActionSheet", mode: "observe" },
    ];

    const unpatches = [];
    const patchedTypes = new Set();
    const memberCache = new Map();
    const renderCounts = {};

    // ---------- debug log ----------
    const logs = [];
    const listeners = new Set();

    function log(msg) {
        const line = new Date().toISOString().slice(11, 19) + " " + String(msg).slice(0, 400);
        logs.push(line);
        if (logs.length > MAX_LOG_LINES) logs.shift();
        try { logger.log("[ClickableRoles] " + msg); } catch (e) { }
        try { if (storage) storage.log = logs.slice(-150); } catch (e) { }
        listeners.forEach(fn => { try { fn(); } catch (e) { } });
    }

    function errMsg(e) {
        try {
            if (!e) return String(e);
            let s = e.message || String(e);
            if (e.status) s += " (status " + e.status + ")";
            if (e.body) s += " body=" + JSON.stringify(e.body).slice(0, 200);
            return s;
        } catch (x) { return "unprintable error"; }
    }

    function typeName(t) {
        try {
            if (t == null) return "none";
            if (typeof t === "string") return t;
            return t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) ||
                (t.render && (t.render.displayName || t.render.name)) || "anonymous";
        } catch (e) { return "?"; }
    }

    function summarize(v, depth) {
        depth = depth || 0;
        try {
            if (v == null) return String(v);
            const t = typeof v;
            if (t === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "..." : v);
            if (t === "number" || t === "boolean") return String(v);
            if (t === "function") return "fn";
            if (Array.isArray(v)) return "[" + v.length + "]";
            if (React.isValidElement(v)) return "<" + typeName(v.type) + ">";
            if (t === "object") {
                const keys = Object.keys(v);
                if (depth >= 1) return "{" + keys.slice(0, 8).join(",") + "}";
                return "{" + keys.slice(0, 10).map(k => k + ":" + summarize(v[k], depth + 1)).join(", ") + "}";
            }
            return t;
        } catch (e) { return "?"; }
    }

    // ---------- lookups ----------
    const GuildRoleStore = findByStoreName("GuildRoleStore");
    const UserStore = findByStoreName("UserStore");
    const SelectedGuildStore = findByStoreName("SelectedGuildStore");
    const RestAPI = findByProps("getAPIBaseURL", "get");
    const UserUtils = findByProps("getUser", "fetchCurrentUser");
    const LazySheet = findByProps("openLazy", "hideActionSheet");
    const SheetUI = findByProps("ActionSheet");

    // ---------- data ----------
    async function fetchMemberIds(guildId, roleId) {
        const key = guildId + "-" + roleId;
        const cached = memberCache.get(key);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.ids;
        const res = await RestAPI.get({ url: "/guilds/" + guildId + "/roles/" + roleId + "/member-ids" });
        const ids = res.body;
        memberCache.set(key, { ids, timestamp: Date.now() });
        return ids;
    }

    async function resolveUsers(ids) {
        const users = await Promise.all(ids.map(async id => {
            const known = UserStore.getUser(id);
            if (known) return known;
            try { return await UserUtils.getUser(id); } catch (e) { return null; }
        }));
        return users.filter(Boolean);
    }

    function avatarUrl(user) {
        try {
            const u = user.getAvatarURL && user.getAvatarURL(undefined, 64, false);
            const uri = typeof u === "string" ? u : u && u.uri;
            if (uri) return uri;
        } catch (e) { }
        if (user.avatar) return "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=64";
        const idx = Number(user.discriminator) > 0 ? Number(user.discriminator) % 5 : 0;
        return "https://cdn.discordapp.com/embed/avatars/" + idx + ".png";
    }

    function roleColor(role) {
        if (role && role.colorString) return role.colorString;
        if (role && role.color) return "#" + role.color.toString(16).padStart(6, "0");
        return "#99aab5";
    }

    function openProfile(userId, guildId) {
        try { LazySheet.hideActionSheet(); } catch (e) { }
        setTimeout(() => {
            try {
                const actions = findByProps("showUserProfile");
                if (!actions) { log("openProfile: showUserProfile module not found"); return; }
                actions.showUserProfile({ userId, guildId });
            } catch (e) {
                log("openProfile failed: " + errMsg(e));
            }
        }, 300);
    }

    // ---------- members sheet ----------
    function RoleMembersSheet(props) {
        const { roleId, guildId } = props;
        const [state, setState] = React.useState({ loading: true, total: 0, users: [], error: false });

        React.useEffect(() => {
            let cancelled = false;
            (async () => {
                try {
                    const ids = await fetchMemberIds(guildId, roleId);
                    log("sheet: fetched " + (ids && ids.length) + " member ids for role " + roleId);
                    const users = await resolveUsers(ids.slice(0, MAX_VISIBLE_MEMBERS));
                    log("sheet: resolved " + users.length + " users");
                    if (!cancelled) setState({ loading: false, total: ids.length, users, error: false });
                } catch (e) {
                    log("sheet: fetch failed: " + errMsg(e));
                    if (!cancelled) setState({ loading: false, total: 0, users: [], error: true });
                }
            })();
            return () => { cancelled = true; };
        }, [guildId, roleId]);

        const role = GuildRoleStore.getRole(guildId, roleId);
        const name = (role && role.name) || "Unknown Role";

        const header = h(Forms.FormRow, {
            key: "header",
            label: state.loading ? name : name + " \u2014 " + state.total,
            leading: h(RN.View, { style: { width: 12, height: 12, borderRadius: 6, backgroundColor: roleColor(role) } }),
        });

        let rows;
        if (state.loading) {
            rows = [h(Forms.FormRow, { key: "loading", label: "Loading members..." })];
        } else if (state.error) {
            rows = [h(Forms.FormRow, { key: "error", label: "Couldn't load members for this role." })];
        } else if (!state.users.length) {
            rows = [h(Forms.FormRow, { key: "empty", label: "No members found." })];
        } else {
            rows = state.users.map(user => h(Forms.FormRow, {
                key: user.id,
                label: user.globalName || user.username,
                leading: h(RN.Image, { source: { uri: avatarUrl(user) }, style: { width: 24, height: 24, borderRadius: 12 } }),
                onPress: () => openProfile(user.id, guildId),
            }));
            if (state.total > MAX_VISIBLE_MEMBERS) {
                rows.push(h(Forms.FormRow, { key: "more", label: "and " + (state.total - MAX_VISIBLE_MEMBERS) + " more" }));
            }
        }

        const body = h(RN.ScrollView, { style: { maxHeight: 420 }, contentContainerStyle: { paddingBottom: 24 } }, header, ...rows);
        const Container = SheetUI && SheetUI.ActionSheet;
        return Container ? h(Container, null, body) : body;
    }

    function openRoleMembers(roleId, guildId) {
        log("openRoleMembers role=" + roleId + " guild=" + guildId);
        try {
            LazySheet.openLazy(Promise.resolve({ default: RoleMembersSheet }), "ClickableRolesSheet", { roleId, guildId });
        } catch (e) {
            log("openLazy failed: " + errMsg(e));
        }
    }

    // ---------- render hook ----------
    function handleRender(name, args, ret) {
        const n = (renderCounts[name] = (renderCounts[name] || 0) + 1);
        const p = (args && args[0]) || {};
        const roleId = (p.role && p.role.id) || p.roleId || p.id;
        const guildId = p.guildId || (p.role && p.role.guildId) || (SelectedGuildStore && SelectedGuildStore.getGuildId());

        let decision;
        if (!ret) decision = "skip: render returned nothing";
        else if (!roleId) decision = "skip: no role id in props";
        else if (!guildId) decision = "skip: no guild id";
        else if (roleId === guildId) decision = "skip: @everyone";
        else if (!GuildRoleStore || !GuildRoleStore.getRole(guildId, roleId)) decision = "skip: role not in store";
        else decision = "wrap";

        if (n <= VERBOSE_RENDERS) {
            log(name + " #" + n + " props=" + summarize(p) +
                " ret=" + typeName(ret && ret.type) +
                " retProps=" + (ret && ret.props ? Object.keys(ret.props).slice(0, 12).join(",") : "-") +
                " -> " + decision);
        }
        if (decision !== "wrap") return;

        const open = () => openRoleMembers(roleId, guildId);
        if (React.isValidElement(ret) && ret.props && typeof ret.props.onPress === "function") {
            if (n <= VERBOSE_RENDERS) log(name + " #" + n + ": root has onPress, overriding it");
            return React.cloneElement(ret, { onPress: open });
        }
        return h(RN.Pressable, { onPress: open }, ret);
    }

    function dumpTree(node, depth, out, budget) {
        if (budget.n <= 0 || depth > 9) return;
        if (Array.isArray(node)) { node.forEach(c => dumpTree(c, depth, out, budget)); return; }
        if (!React.isValidElement(node)) return;
        budget.n--;
        const p = node.props || {};
        const keys = Object.keys(p).filter(k => k !== "children").slice(0, 8).map(k => k + "=" + summarize(p[k], 0));
        out.push("  ".repeat(depth) + typeName(node.type) + " " + keys.join(" "));
        dumpTree(p.children, depth + 1, out, budget);
    }

    function logTree(label, ret) {
        const out = [];
        dumpTree(ret, 0, out, { n: 45 });
        log(label + " tree (" + out.length + " nodes):");
        out.forEach(l => log("| " + l));
    }

    // Returns the same reference when nothing below changed.
    function mapTree(node, fn, depth) {
        if (depth > 14) return node;
        if (Array.isArray(node)) {
            let changed = false;
            const mapped = node.map(c => {
                const r = mapTree(c, fn, depth + 1);
                if (r !== c) changed = true;
                return r;
            });
            return changed ? mapped : node;
        }
        if (!React.isValidElement(node)) return node;
        const replaced = fn(node);
        if (replaced) return replaced;
        const children = node.props && node.props.children;
        if (children == null) return node;
        const newChildren = mapTree(children, fn, depth + 1);
        return newChildren === children ? node : React.cloneElement(node, { children: newChildren });
    }

    function proxyEnabled() {
        try { return !(storage && storage.proxyOff); } catch (e) { return true; }
    }

    function wrapRoleNode(node, outerGuild) {
        const np = node.props || {};
        const roleId = (np.role && np.role.id) || np.roleId || np.id;
        const guildId = np.guildId || (np.role && np.role.guildId) || outerGuild;
        if (!roleId || !guildId || roleId === guildId) return null;
        if (!GuildRoleStore || !GuildRoleStore.getRole(guildId, roleId)) return null;
        return h(RN.Pressable, { key: node.key, onPress: () => openRoleMembers(roleId, guildId) }, node);
    }

    function callComponent(c, props) {
        if (typeof c === "function") {
            if (c.prototype && c.prototype.isReactComponent) throw new Error("class component");
            return c(props);
        }
        if (c && typeof c.type === "function") return callComponent(c.type, props);
        if (c && typeof c.render === "function") return c.render(props, null);
        throw new Error("unsupported component type");
    }

    // RolesList isn't exported from any module, so we render it ourselves from inside this proxy
    // and wrap the role elements it produces.
    let proxyRenders = 0;
    function RolesListProxy(props) {
        const orig = props.__crOrig;
        const rest = Object.assign({}, props);
        delete rest.__crOrig;
        const n = ++proxyRenders;
        if (n <= 3) log("proxy #" + n + ": calling original RolesList (" + typeName(orig) + ")");
        let out;
        try {
            out = callComponent(orig, rest);
            if (n <= 3) log("proxy #" + n + ": original returned " + typeName(out && out.type));
        } catch (e) {
            log("RolesList proxy: couldn't call original (" + errMsg(e) + "), rendering it untouched");
            return h(orig, rest);
        }
        const outerGuild = rest.guildId || (SelectedGuildStore && SelectedGuildStore.getGuildId());
        let wrapped = 0;
        const mapped = mapTree(out, node => {
            const w = wrapRoleNode(node, outerGuild);
            if (w) wrapped++;
            return w;
        }, 0);
        if (n <= 3) {
            log("RolesList proxy #" + n + " props=" + summarize(rest) + " -> wrapped " + wrapped + " role element(s)");
            if (n <= 2) logTree("RolesList #" + n, out);
        }
        return mapped;
    }

    function handleTree(name, args, ret) {
        const n = (renderCounts[name] = (renderCounts[name] || 0) + 1);
        const p = (args && args[0]) || {};
        const outerGuild = p.guildId || (SelectedGuildStore && SelectedGuildStore.getGuildId());
        let wrapped = 0;
        let proxied = 0;
        const out = mapTree(ret, node => {
            const np = node.props || {};
            if (np.guildMemberRoleIds && node.type && typeof node.type !== "string" && node.type !== RolesListProxy && proxyEnabled()) {
                proxied++;
                return h(RolesListProxy, Object.assign({}, np, { key: node.key, __crOrig: node.type }));
            }
            const w = wrapRoleNode(node, outerGuild);
            if (w) wrapped++;
            return w;
        }, 0);
        if (n <= 3) {
            log(name + " #" + n + " props=" + summarize(p) + " -> wrapped " + wrapped + ", proxied " + proxied);
            if (n <= 2) logTree(name + " #" + n, ret);
        }
        return wrapped || proxied ? out : undefined;
    }

    function handleObserve(name, args, ret) {
        const n = (renderCounts[name] = (renderCounts[name] || 0) + 1);
        if (n <= 2) {
            log(name + " #" + n + " props=" + summarize((args && args[0]) || {}) + " ret=" + typeName(ret && ret.type));
            logTree(name + " #" + n, ret);
        }
    }

    function roleIdFromSection(section, guildId) {
        if (!section) return null;
        const cands = [section.roleId, section.id, section.role && section.role.id, section.key, section.groupId];
        for (const c of cands) {
            if (c && c !== guildId && GuildRoleStore && GuildRoleStore.getRole(guildId, String(c))) return String(c);
        }
        return null;
    }

    // Member list: wrap the section header renderer so role headers become tappable.
    function handleMembers(name, args, ret) {
        const n = (renderCounts[name] = (renderCounts[name] || 0) + 1);
        const p = (args && args[0]) || {};
        const outerGuild = p.guildId || (SelectedGuildStore && SelectedGuildStore.getGuildId());
        let patched = 0;
        const out = mapTree(ret, node => {
            const np = node.props || {};
            const list = np.sections || np.data;
            if (n <= 2 && Array.isArray(list)) {
                log(name + " #" + n + " " + typeName(node.type) + " " + (np.sections ? "sections" : "data") + "[" + list.length + "]: " +
                    list.slice(0, 3).map(x => summarize(x, 0)).join(" | "));
            }
            if (typeof np.renderSectionHeader === "function" && !np.renderSectionHeader.__cr) {
                const orig = np.renderSectionHeader;
                let calls = 0;
                const wrappedFn = function (info) {
                    const r = orig.apply(this, arguments);
                    try {
                        const section = info && info.section;
                        const guildId = (section && section.guildId) || outerGuild;
                        const roleId = roleIdFromSection(section, guildId);
                        if (++calls <= 4) log("sectionHeader #" + calls + " section=" + summarize(section, 0) + " -> role " + roleId);
                        if (roleId && r) return h(RN.Pressable, { onPress: () => openRoleMembers(roleId, guildId) }, r);
                    } catch (e) {
                        log("sectionHeader error: " + errMsg(e));
                    }
                    return r;
                };
                wrappedFn.__cr = true;
                patched++;
                return React.cloneElement(node, { renderSectionHeader: wrappedFn });
            }
            return null;
        }, 0);
        if (n <= 2) {
            log(name + " #" + n + " props=" + summarize(p) + " ret=" + typeName(ret && ret.type) + " -> patched " + patched + " section list(s)");
            logTree(name + " #" + n, ret);
        }
        return patched ? out : undefined;
    }

    function makeAfter(name, mode) {
        return function (args, ret) {
            try {
                if (mode === "tree") return handleTree(name, args, ret);
                if (mode === "observe") return handleObserve(name, args, ret);
                if (mode === "members") return proxyEnabled() ? handleMembers(name, args, ret) : undefined;
                return handleRender(name, args, ret);
            } catch (e) {
                log("ERROR in " + name + " hook: " + errMsg(e));
            }
        };
    }

    function patchModule(mod, name, mode) {
        const cb = makeAfter(name, mode);
        const def = mod && mod.default;
        if (typeof def === "function") return patcher.after("default", mod, cb);
        if (def && typeof def.type === "function") return patcher.after("type", def, cb);
        if (def && typeof def.render === "function") return patcher.after("render", def, cb);
        return null;
    }

    // ---------- debug tools ----------
    function discover() {
        const found = new Set();
        const mods = metro.modules || {};
        let scanned = 0;
        for (const id in mods) {
            try {
                const m = mods[id];
                if (!m || !m.isInitialized) continue;
                const ex = m.publicModule && m.publicModule.exports;
                if (!ex) continue;
                scanned++;
                for (const c of [ex, ex.default]) {
                    const n = c && (c.displayName || c.name || (c.type && (c.type.displayName || c.type.name)));
                    if (typeof n === "string" && /role|member|sectionheader|profile|pill|tag/i.test(n)) found.add(n);
                }
            } catch (e) { }
        }
        const names = Array.from(found).sort();
        log("scan: " + scanned + " modules, " + names.length + " matching names");
        let chunk = "";
        for (const n of names) {
            if (chunk.length + n.length > 500) { log("scan: " + chunk); chunk = ""; }
            chunk += (chunk ? ", " : "") + n;
        }
        if (chunk) log("scan: " + chunk);
    }

    function testSheet() {
        try {
            const guildId = SelectedGuildStore && SelectedGuildStore.getGuildId();
            if (!guildId) { log("test: no server selected (open a server first)"); return; }
            let roles = GuildRoleStore.getSortedRoles ? GuildRoleStore.getSortedRoles(guildId) : null;
            if (!roles && GuildRoleStore.getRoles) roles = Object.values(GuildRoleStore.getRoles(guildId) || {});
            const role = (roles || []).find(r => r && r.id !== guildId);
            if (!role) { log("test: no roles found for guild " + guildId); return; }
            log("test: using role " + role.name + " (" + role.id + ")");
            openRoleMembers(role.id, guildId);
        } catch (e) {
            log("test failed: " + errMsg(e));
        }
    }

    // Render tracer: temporarily counts renders of every function component whose name looks
    // related, so we can see which ones fire while you open the member list.
    const TRACE_RE = /member|role|section|header|list|group|online|pill|tag|row|item/i;
    let traceUnpatches = [];
    let traceCounts = {};
    let traceProps = {};

    // Built by a factory so every probe keeps its own name (closures made directly inside the
    // scan loop all reported the same name on-device).
    function makeProbe(probeName) {
        return function (args) {
            traceCounts[probeName] = (traceCounts[probeName] || 0) + 1;
            if (!traceProps[probeName]) traceProps[probeName] = summarize((args && args[0]) || {}, 0).slice(0, 170);
        };
    }

    function stopTrace(quiet) {
        const n = traceUnpatches.length;
        while (traceUnpatches.length) { try { traceUnpatches.pop()(); } catch (e) { } }
        if (n && !quiet) log("trace: stopped, removed " + n + " probes");
    }

    function startTrace() {
        stopTrace(true);
        traceCounts = {};
        traceProps = {};
        const seen = new Set();
        const mods = metro.modules || {};
        for (const id in mods) {
            try {
                const m = mods[id];
                if (!m || !m.isInitialized) continue;
                const ex = m.publicModule && m.publicModule.exports;
                if (!ex) continue;
                const holders = [[ex, "default"]];
                for (const k of Object.keys(ex)) holders.push([ex, k]);
                for (const pair of holders) {
                    const holder = pair[0], key = pair[1];
                    let v;
                    try { v = holder[key]; } catch (e) { continue; }
                    if (typeof v !== "function" || seen.has(v)) continue;
                    if (v.prototype && v.prototype.isReactComponent) continue;
                    const name = typeName(v);
                    if (!/^[A-Z]/.test(name) || !TRACE_RE.test(name)) continue;
                    seen.add(v);
                    try {
                        const un = patcher.after(key, holder, makeProbe(name));
                        if (un) traceUnpatches.push(un);
                    } catch (e) { }
                }
            } catch (e) { }
        }
        log("trace: started with " + traceUnpatches.length + " probes. Now open the member list, then press 'Stop & log trace'.");
    }

    function finishTrace() {
        const entries = Object.keys(traceCounts).map(k => [k, traceCounts[k]]).sort((a, b) => b[1] - a[1]);
        stopTrace(true);
        log("trace: " + entries.length + " components rendered");
        entries.slice(0, 100).forEach(e => log("trace: " + e[0] + " x" + e[1] + " props=" + traceProps[e[0]]));
    }

    function copyLog() {
        try {
            const Clip = (metro.common && metro.common.clipboard) || findByProps("setString");
            Clip.setString(logs.join("\n"));
            ui.toasts.showToast("Log copied");
        } catch (e) {
            log("copy failed: " + errMsg(e));
        }
    }

    function DebugSettings() {
        const [, force] = React.useReducer(x => x + 1, 0);
        React.useEffect(() => {
            listeners.add(force);
            return () => { listeners.delete(force); };
        }, []);

        const switchRow = Forms.FormSwitchRow ? h(Forms.FormSwitchRow, {
            label: "Make profile roles tappable",
            value: !(storage && storage.proxyOff),
            onValueChange: v => { if (storage) storage.proxyOff = !v; log("profile roles hook " + (v ? "enabled" : "disabled") + " (applies on next profile open)"); force(); },
        }) : null;

        return h(RN.ScrollView, null,
            h(Forms.FormSection, { title: "ClickableRoles " + BUILD },
                switchRow,
                h(Forms.FormRow, { label: "Copy log", onPress: copyLog }),
                h(Forms.FormRow, { label: "Clear log", onPress: () => { logs.length = 0; log("log cleared"); } }),
                h(Forms.FormRow, { label: "Scan components", onPress: discover }),
                h(Forms.FormRow, { label: "Start render trace", onPress: startTrace }),
                h(Forms.FormRow, { label: "Stop & log trace", onPress: finishTrace }),
                h(Forms.FormRow, { label: "Log render counts", onPress: () => log("render counts: " + JSON.stringify(renderCounts)) }),
                h(Forms.FormRow, { label: "Open test sheet (current server)", onPress: testSheet })
            ),
            h(Forms.FormSection, { title: "Log (" + logs.length + " lines)" },
                h(Forms.FormText, { selectable: true, style: { padding: 12, fontSize: 11 } }, logs.join("\n") || "(empty)")
            ),
            prevLog.length ? h(Forms.FormSection, { title: "Previous session log (" + prevLog.length + " lines)" },
                h(Forms.FormRow, { label: "Copy previous session log", onPress: () => {
                    try { (metro.common.clipboard || findByProps("setString")).setString(prevLog.join("\n")); ui.toasts.showToast("Previous log copied"); } catch (e) { log("copy failed: " + errMsg(e)); }
                } }),
                h(Forms.FormText, { selectable: true, style: { padding: 12, fontSize: 11 } }, prevLog.join("\n"))
            ) : null
        );
    }

    return {
        onLoad() {
            try {
                const G = typeof globalThis !== "undefined" ? globalThis : global;
                if (G.__clickableRolesCleanup) { try { G.__clickableRolesCleanup(); } catch (e) { } }
                G.__clickableRolesCleanup = () => { while (unpatches.length) unpatches.pop()(); };
                this.__load();
            } catch (e) {
                log("onLoad error: " + errMsg(e));
                try { ui.toasts.showToast("ClickableRoles onLoad error: " + errMsg(e)); } catch (x) { }
            }
        },
        __load() {
            log("build " + BUILD + " loading");
            log("modules: GuildRoleStore=" + !!GuildRoleStore + " UserStore=" + !!UserStore +
                " SelectedGuildStore=" + !!SelectedGuildStore + " RestAPI=" + !!RestAPI +
                " UserUtils=" + !!UserUtils + " LazySheet=" + !!LazySheet + " ActionSheet=" + !!(SheetUI && SheetUI.ActionSheet) +
                " showUserProfile=" + !!findByProps("showUserProfile"));

            const hooked = [];
            for (const t of TARGETS) {
                const name = t.name;
                try {
                    const mod = findByName(name, false);
                    if (!mod) { log("not found: " + name); continue; }
                    const unpatch = patchModule(mod, name, t.mode);
                    if (unpatch) { unpatches.push(unpatch); hooked.push(name + "(" + t.mode + ")"); if (mod.default) patchedTypes.add(mod.default); }
                    else log("found " + name + " but couldn't patch it (default export is " + typeof mod.default + ")");
                } catch (e) {
                    log("failed to patch " + name + ": " + errMsg(e));
                }
            }
            log("hooked: " + (hooked.join(", ") || "nothing"));
            ui.toasts.showToast("ClickableRoles " + BUILD + " hooked: " + (hooked.join(", ") || "nothing"));
        },
        onUnload() {
            stopTrace(true);
            while (unpatches.length) unpatches.pop()();
        },
        settings: DebugSettings,
    };
    }

    try {
        return build();
    } catch (e) {
        try { vendetta.logger.log("[ClickableRoles] init error: " + (e && e.message)); } catch (x) { }
        try { vendetta.ui.toasts.showToast("ClickableRoles init error: " + (e && e.message)); } catch (x) { }
        return { onLoad() { }, onUnload() { } };
    }
})();
