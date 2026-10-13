/*
 * ClickableRoles for Revenge Classic
 * Port of the Equicord/Vencord ClickableRoles plugin by prism.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
    "use strict";

    const { metro, patcher, ui, logger } = vendetta;
    const { findByProps, findByName, findByStoreName } = metro;
    const { React, ReactNative: RN } = metro.common;
    const { Forms } = ui.components;
    const h = React.createElement;

    const MAX_VISIBLE_MEMBERS = 20;
    const CACHE_TTL = 60000;

    // Component names to try hooking. Each one is only wrapped when its props
    // point at a real role in the current guild, so a wrong guess is harmless.
    const CANDIDATES = [
        "UserProfileRoles", "UserProfileRole", "ProfileRole", "RoleTag", "RolePill", "RoleChip",
        "MemberListSectionHeader", "ChannelMemberListSectionHeader", "GuildMemberListSectionHeader",
        "MemberSectionHeader", "MemberListHeader",
    ];

    const unpatches = [];
    const memberCache = new Map();

    const GuildRoleStore = findByStoreName("GuildRoleStore");
    const UserStore = findByStoreName("UserStore");
    const SelectedGuildStore = findByStoreName("SelectedGuildStore");
    const RestAPI = findByProps("getAPIBaseURL", "get");
    const UserUtils = findByProps("getUser", "fetchCurrentUser");
    const LazySheet = findByProps("openLazy", "hideActionSheet");
    const SheetUI = findByProps("ActionSheet");

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
                actions.showUserProfile({ userId, guildId });
            } catch (e) {
                logger.error("[ClickableRoles] Failed to open profile", e);
            }
        }, 300);
    }

    function RoleMembersSheet(props) {
        const { roleId, guildId } = props;
        const [state, setState] = React.useState({ loading: true, total: 0, users: [], error: false });

        React.useEffect(() => {
            let cancelled = false;
            (async () => {
                try {
                    const ids = await fetchMemberIds(guildId, roleId);
                    const users = await resolveUsers(ids.slice(0, MAX_VISIBLE_MEMBERS));
                    if (!cancelled) setState({ loading: false, total: ids.length, users, error: false });
                } catch (e) {
                    logger.error("[ClickableRoles] Failed to fetch role members", e);
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
        LazySheet.openLazy(Promise.resolve({ default: RoleMembersSheet }), "ClickableRolesSheet", { roleId, guildId });
    }

    function wrap(ret, roleId, guildId) {
        return h(RN.Pressable, { onPress: () => openRoleMembers(roleId, guildId) }, ret);
    }

    function afterRender(args, ret) {
        const p = (args && args[0]) || {};
        const roleId = (p.role && p.role.id) || p.roleId || p.id;
        const guildId = p.guildId || (p.role && p.role.guildId) || (SelectedGuildStore && SelectedGuildStore.getGuildId());
        if (!ret || !roleId || !guildId || roleId === guildId) return;
        if (!GuildRoleStore.getRole(guildId, roleId)) return;
        return wrap(ret, roleId, guildId);
    }

    function patchModule(mod) {
        const def = mod && mod.default;
        if (typeof def === "function") return patcher.after("default", mod, afterRender);
        if (def && typeof def.type === "function") return patcher.after("type", def, afterRender);
        if (def && typeof def.render === "function") return patcher.after("render", def, afterRender);
        return null;
    }

    // Logs component names that look relevant, so hook targets can be corrected.
    function discover() {
        const found = new Set();
        const mods = metro.modules || {};
        for (const id in mods) {
            try {
                const m = mods[id];
                if (!m || !m.isInitialized) continue;
                const ex = m.publicModule && m.publicModule.exports;
                if (!ex) continue;
                for (const c of [ex, ex.default]) {
                    const n = c && (c.displayName || c.name || (c.type && (c.type.displayName || c.type.name)));
                    if (typeof n === "string" && /role|memberlist|sectionheader/i.test(n)) found.add(n);
                }
            } catch (e) { }
        }
        logger.log("[ClickableRoles] Candidate components: " + Array.from(found).sort().join(", "));
    }

    return {
        onLoad() {
            const hooked = [];
            for (const name of CANDIDATES) {
                try {
                    const mod = findByName(name, false);
                    const unpatch = mod && patchModule(mod);
                    if (unpatch) { unpatches.push(unpatch); hooked.push(name); }
                } catch (e) {
                    logger.error("[ClickableRoles] Failed to patch " + name, e);
                }
            }
            logger.log("[ClickableRoles] Hooked: " + (hooked.join(", ") || "nothing"));
            if (!hooked.length) {
                discover();
                ui.toasts.showToast("ClickableRoles: no role components found, check debug logs");
            }
        },
        onUnload() {
            while (unpatches.length) unpatches.pop()();
        },
    };
})();
