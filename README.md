# APPL-E

APPL-E is a Root community bot focused on stream notifications, welcome/goodbye automation, role workflows, and moderation utilities.

## Features

- Live alerts for **YouTube** and **Twitch**
- YouTube new video and premiere announcements
- Per-community streamer subscriptions (shared global catalog + local subscriptions)
- Welcome and goodbye messages (text + image)
- Auto role on join and reaction-based role assignment
- Admin and moderator role-based permission model
- AutoMod with keyword/regex rules
- Moderation actions: mute, unmute, tempban, tempkick
- Moderation logs channel
- English and Portuguese support
- Command prefix customization

## Requirements

- Node.js 22+
- A Root app/bot from the [Root Developer Portal](https://dev.rootapp.com)

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` in project root:

```env
DEV_TOKEN=your_dev_token
COMMUNITY_ID=your_test_community_id
YOUTUBE_API_KEY=optional_for_youtube
TWITCH_CLIENT_ID=optional_for_twitch
TWITCH_CLIENT_SECRET=optional_for_twitch
```

3. Build and run:

```bash
npm run build
npm run bot
```

## Permission Model

- `Admin role`: full bot configuration access.
- `Mod role`: moderation + automod access.
- `Override role`: bypasses AutoMod filtering (keywords/regex), but **does not bypass manual moderation commands**.
- If neither admin role nor mod role is configured, moderation actions are disabled for safety.

## Global Settings (Root App Settings)

- `Language`: default bot language (`en`/`pt`)
- `Default command prefix`: global fallback prefix (local prefix can override)

## Command Groups

All examples assume prefix `!`.

### Core

- `!ping` (`!p`)
- `!help` (`!h`)

### General Settings (`!set` / `!s`)

- `!set adminRole <@role|roleId|name>` (`!s ar <...>`)
- `!set adminRole clear`
- `!set language <en|pt>` (`!s lg <...>`)
- `!set debug <on|off>` (`!s d <...>`)
- `!set prefix <prefix>`
- `!set autorole <messageId> <emoji> <@role|roleId|name> [one|many]` (`!s atr ...`)
- `!set autorole <messageId> <@role|roleId|name> [one|many]` (guided setup)
- `!set autorole remove <messageId> <emoji>` (`!s atr remove ...`)

### Stream Commands (`!stream` / `!st`)

Public:

- `!stream list` (`!st l`)
- `!stream help` (`!st h`)

Admin:

- `!stream live [contains]` (`!st v`)
- `!stream add <name|uid|url> [| Display Name]` (`!st +`)
- `!stream remove <index>` (`!st -`)
- `!stream channel <#channel|channelId|name>` (`!st c`)
- `!stream role <@role|roleId|name>` (`!st r`)
- `!stream message <text>` (`!st m`)
- `!stream info` (`!st i`)
- `!stream test` (`!st t`)
- `!stream reset` (`!st rs`)
- `!stream admin <@role|roleId|name>` (`!st ad`)
- `!stream admin clear`

### Welcome / Goodbye

Welcome (`!welcome` / `!wc`):

- `!welcome add <channel|message|image> <value>` (`!wc + ...`)
- `!welcome remove <channel|message|image>` (`!wc - ...`)
- `!welcome channel <#channel|channelId|name>` (`!wc c ...`)
- `!welcome message <text>` (`!wc m ...`)
- `!welcome image <https://... | [image](https://...)>` (`!wc i ...`)
- `!welcome info` (`!wc i`)
- `!welcome test` (`!wc t`)
- `!welcome reset` (`!wc rs`)

Goodbye (`!goodbye` / `!gb`):

- `!goodbye add <channel|message|image> <value>` (`!gb + ...`)
- `!goodbye remove <channel|message|image>` (`!gb - ...`)
- `!goodbye channel <#channel|channelId|name>` (`!gb c ...`)
- `!goodbye message <text>` (`!gb m ...`)
- `!goodbye image <https://... | [image](https://...)>` (`!gb i ...`)
- `!goodbye info` (`!gb i`)
- `!goodbye test` (`!gb t`)
- `!goodbye reset` (`!gb rs`)

### AutoMod (`!automod` / `!am`)

- `!automod info`
- `!automod <delete|kick|ban> <words|regex> <comma,separated,values>`
- `!automod <delete|kick|ban> clear`

Examples:

- `!am delete words spam,scam`
- `!am ban regex /discord\.gg\/\w+/i`

### Moderation (`!mod` / `!md`)

Configuration (admin only):

- `!mod role <@role|roleId|name>` (`!md r ...`)
- `!mod role clear`
- `!mod override <@role|roleId|name>` (`!md ov ...`)
- `!mod override clear`
- `!mod logs <#channel|channelId|name>` (`!md lg ...`)
- `!mod logs clear`

Actions (mod+admin):

- `!mod mute <@user|userId> <duration> [reason]` (`!md m ...`)
- `!mod unmute <@user|userId>` (`!md um ...`)
- `!mod tempban <@user|userId> <duration> [reason]` (`!md tb ...`)
- `!mod tempkick <@user|userId> <duration> [reason]` (`!md tk ...`)

Duration formats:

- `30` or `30s`
- `30m`
- `30h`
- `2d`
- Maximum is capped at `7d`.

## Moderation Behavior Notes

- Muted users have new text messages deleted immediately.
- APPL-E attempts to DM muted users with remaining time (best-effort, SDK/runtime dependent).
- Mute also attempts to apply server mute on voice channels.
- If a moderation logs channel is configured, APPL-E logs moderation/config actions there.

## Project Structure

- `src/main.ts`: app lifecycle and module registration
- `src/commands.ts`: command parsing and handlers
- `src/streams.ts`: stream polling and announcements
- `src/streamDiscovery.ts`: input resolution for YouTube/Twitch
- `src/streamRegistry.ts`: streamer catalog/subscription mapping
- `src/welcome.ts`: welcome/goodbye logic
- `src/roles.ts`: join auto-role
- `src/autorole.ts`: reaction-role mapping and handlers
- `src/automod.ts`: automod + moderation enforcement
- `src/permissions.ts`: admin/mod/override permission helpers
- `src/i18n/translations.ts`: PT/EN text keys
- `root-manifest.json`: Root app manifest

## References

- [Root Bot Docs](https://docs.rootapp.com/docs/bot-docs/bot-home/)
- [Root Community API](https://docs.rootapp.com/docs/bot-docs/develop/community-api/)
