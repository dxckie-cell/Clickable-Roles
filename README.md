# ClickableRoles

A [Revenge Classic](https://github.com/revenge-mod) plugin that makes roles in user profiles tappable. Tap a role to see which members have it.

## Features

- Tap any role pill in a user's profile to open a sheet listing the members of that role.
- Shows the role's name, color and member count.
- Scrollable list, loaded 30 members at a time with a **Load more** button for large roles.
- Tap a member in the list to open their profile.

## Install

In Revenge, go to **Plugins → +** and add:

```
https://dxckie-cell.github.io/Clickable-Roles/
```

## How it works

Revenge Classic runs plain JavaScript plugins, so this is a port rather than a copy of the original, which patches Discord's desktop UI. The plugin hooks the profile's roles card, wraps each role pill so it can be pressed, and fetches the role's member IDs from Discord's `member-ids` endpoint. User details are then looked up and shown in an action sheet.

## Limitations

- Only the profile role list is supported. Roles in the channel member list are not tappable yet.
- Members Discord won't return user info for are skipped, so the list can show fewer people than the count in the header.
- The sheet shows display names or usernames, not server nicknames.
- It relies on Discord's internal component names, so a Discord update can break it until the plugin is updated.

## Credits and license

Ported from the **ClickableRoles** plugin for Equicord/Vencord by prism. Licensed under **GPL-3.0-or-later**, the same license as the original. See `LICENSE`.
