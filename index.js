(function () {
    "use strict";
    /*
     * ClickableRoles for Revenge Classic
     * Port of the Equicord/Vencord ClickableRoles plugin by prism.
     * SPDX-License-Identifier: GPL-3.0-or-later
     */

    function build() {
        const { metro, patcher, ui, logger } = vendetta;
        const { findByProps, findByName, findByStoreName } = metro;
        const { React, ReactNative: RN } = metro.common;
        const { Forms } = ui.components;
        const h = React.createElement;

        const PAGE_SIZE = 30;
        const CACHE_TTL = 60000;

        const unpatches = [];
        const memberCache = new Map();

        const GuildRoleStore = findByStoreName("GuildRoleStore");
        const UserStore = findByStoreName("UserStore");
        const SelectedGuildStore = findByStoreName("SelectedGuildStore");
        const RestAPI = findByProps("getAPIBaseURL", "get");
        const UserUtils = findByProps("getUser", "fetchCurrentUser");
        const LazySheet = findByProps("openLazy", "hideActionSheet");
        const SheetUI = findByProps("ActionSheet");

        const log = msg => { try { logger.log("[ClickableRoles] " + msg); } catch (e) { } };
        const errMsg = e => (e && e.message) || String(e);

        // ---------- data ----------
        async function fetchMemberIds(guildId, roleId) {
            const key = guildId + "-" + roleId;
            const cached = memberCache.get(key);
            if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.ids;
            const res = await RestAPI.get({ url: "/guilds/" + guildId + "/roles/" + roleId + "/member-ids" });
            const ids = Array.from(new Set(res.body));
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
                const u = user.getAvatarURL(undefined, 64, false);
                const uri = typeof u === "string" ? u : u && u.uri;
                if (uri) return uri;
            } catch (e) { }
            return user.avatar
                ? "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=64"
                : "https://cdn.discordapp.com/embed/avatars/0.png";
        }

        function openProfile(userId, guildId) {
            try { LazySheet.hideActionSheet(); } catch (e) { }
            setTimeout(() => {
                try { findByProps("showUserProfile").showUserProfile({ userId, guildId }); }
                catch (e) { log("couldn't open profile: " + errMsg(e)); }
            }, 300);
        }

        // ---------- members sheet ----------
        // Gesture-handler's ScrollView cooperates with the sheet's drag gesture; a plain one can lose it.
        function pickScroller() {
            try {
                const gh = findByProps("GestureHandlerRootView");
                if (gh && gh.ScrollView) return gh.ScrollView;
            } catch (e) { }
            return RN.ScrollView;
        }

        function RoleMembersSheet(props) {
            const { roleId, guildId } = props;
            const [state, setState] = React.useState({ loading: true, ids: [], users: [], cursor: 0, error: false, loadingMore: false });

            React.useEffect(() => {
                let cancelled = false;
                (async () => {
                    try {
                        const ids = await fetchMemberIds(guildId, roleId);
                        const users = await resolveUsers(ids.slice(0, PAGE_SIZE));
                        if (!cancelled) setState({ loading: false, ids, users, cursor: Math.min(PAGE_SIZE, ids.length), error: false, loadingMore: false });
                    } catch (e) {
                        log("couldn't fetch role members: " + errMsg(e));
                        if (!cancelled) setState({ loading: false, ids: [], users: [], cursor: 0, error: true, loadingMore: false });
                    }
                })();
                return () => { cancelled = true; };
            }, [guildId, roleId]);

            // The cursor counts ids consumed, not users shown, so members that fail to resolve don't cause repeats.
            const loadMore = async () => {
                if (state.loadingMore) return;
                const start = state.cursor;
                const end = Math.min(start + PAGE_SIZE, state.ids.length);
                setState(s => Object.assign({}, s, { loadingMore: true }));
                try {
                    const more = await resolveUsers(state.ids.slice(start, end));
                    setState(s => {
                        const seen = new Set(s.users.map(u => u.id));
                        return Object.assign({}, s, { users: s.users.concat(more.filter(u => !seen.has(u.id))), cursor: end, loadingMore: false });
                    });
                } catch (e) {
                    setState(s => Object.assign({}, s, { loadingMore: false }));
                }
            };

            const role = GuildRoleStore.getRole(guildId, roleId);
            const total = state.ids.length;
            const remaining = total - state.cursor;

            const header = h(Forms.FormRow, {
                key: "header",
                label: ((role && role.name) || "Unknown Role") + (state.loading ? "" : " \u2014 " + total),
                leading: h(RN.View, { style: { width: 12, height: 12, borderRadius: 6, backgroundColor: (role && role.colorString) || "#99aab5" } }),
            });

            let rows;
            if (state.loading) rows = [h(Forms.FormRow, { key: "loading", label: "Loading members..." })];
            else if (state.error) rows = [h(Forms.FormRow, { key: "error", label: "Couldn't load members for this role." })];
            else if (!state.users.length) rows = [h(Forms.FormRow, { key: "empty", label: "No members found." })];
            else rows = state.users.map(user => h(Forms.FormRow, {
                key: user.id,
                label: user.globalName || user.username,
                leading: h(RN.Image, { source: { uri: avatarUrl(user) }, style: { width: 24, height: 24, borderRadius: 12 } }),
                onPress: () => openProfile(user.id, guildId),
            }));

            // Outside the scroll area so it is always reachable.
            const footer = !state.loading && !state.error && remaining > 0 ? h(Forms.FormRow, {
                key: "more",
                label: state.loadingMore ? "Loading..." : "Load more (" + remaining + " left)",
                onPress: loadMore,
            }) : null;

            const Scroller = pickScroller();
            const maxHeight = Math.round(RN.Dimensions.get("window").height * 0.55);
            const body = h(RN.View, { style: { paddingBottom: 24 } },
                header,
                h(Scroller, { style: { maxHeight }, nestedScrollEnabled: true }, ...rows),
                footer
            );
            const Container = SheetUI && SheetUI.ActionSheet;
            return Container ? h(Container, null, body) : body;
        }

        function openRoleMembers(roleId, guildId) {
            try {
                LazySheet.openLazy(Promise.resolve({ default: RoleMembersSheet }), "ClickableRolesSheet", { roleId, guildId });
            } catch (e) {
                log("couldn't open sheet: " + errMsg(e));
            }
        }

        // ---------- profile roles ----------
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

        function wrapRoleNode(node, outerGuild) {
            const np = node.props || {};
            const roleId = (np.role && np.role.id) || np.roleId || np.id;
            const guildId = np.guildId || (np.role && np.role.guildId) || outerGuild;
            if (!roleId || !guildId || roleId === guildId) return null;
            if (!GuildRoleStore.getRole(guildId, roleId)) return null;
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

        // RolesList isn't exported anywhere, so it is rendered from inside this proxy and its role pills get wrapped.
        function RolesListProxy(props) {
            const orig = props.__crOrig;
            const rest = Object.assign({}, props);
            delete rest.__crOrig;
            let out;
            try {
                out = callComponent(orig, rest);
            } catch (e) {
                log("couldn't call RolesList: " + errMsg(e));
                return h(orig, rest);
            }
            const outerGuild = rest.guildId || SelectedGuildStore.getGuildId();
            return mapTree(out, node => wrapRoleNode(node, outerGuild), 0);
        }

        function afterProfileRoles(args, ret) {
            try {
                let proxied = 0;
                const out = mapTree(ret, node => {
                    const np = node.props || {};
                    if (np.guildMemberRoleIds && node.type && typeof node.type !== "string" && node.type !== RolesListProxy) {
                        proxied++;
                        return h(RolesListProxy, Object.assign({}, np, { key: node.key, __crOrig: node.type }));
                    }
                    return null;
                }, 0);
                return proxied ? out : undefined;
            } catch (e) {
                log("profile roles hook error: " + errMsg(e));
            }
        }

        function hookProfileRoles() {
            const mod = findByName("UserProfileRolesCard", false);
            const def = mod && mod.default;
            let un = null;
            if (typeof def === "function") un = patcher.after("default", mod, afterProfileRoles);
            else if (def && typeof def.type === "function") un = patcher.after("type", def, afterProfileRoles);
            else if (def && typeof def.render === "function") un = patcher.after("render", def, afterProfileRoles);
            if (un) unpatches.push(un);
            return !!un;
        }

        return {
            onLoad() {
                try {
                    // Drop patches left over from a previous load that wasn't unloaded cleanly.
                    const G = typeof globalThis !== "undefined" ? globalThis : global;
                    if (G.__clickableRolesCleanup) { try { G.__clickableRolesCleanup(); } catch (e) { } }
                    G.__clickableRolesCleanup = () => { while (unpatches.length) unpatches.pop()(); };
                    if (!hookProfileRoles()) log("UserProfileRolesCard not found, profile roles won't be tappable");
                } catch (e) {
                    log("onLoad error: " + errMsg(e));
                }
            },
            onUnload() {
                while (unpatches.length) unpatches.pop()();
            },
        };
    }

    try {
        return build();
    } catch (e) {
        try { vendetta.logger.log("[ClickableRoles] init error: " + (e && e.message)); } catch (x) { }
        return { onLoad() { }, onUnload() { } };
    }
})();
