# Legcord DVM Bridge

This is a Legcord bridge for Stream Deck Discord Volume Mixer.

Legcord's built-in arRPC support exposes Rich Presence RPC commands, but it does not expose Discord's voice mixer commands. For Legcord 1.2.x this bridge loads as a local extension and connects to the Stream Deck plugin over `127.0.0.1:6888`, which is already allowed by Legcord's localhost WebSocket filter. For newer Legcord builds with runtime main-process plugins, `main.js` can provide the same bridge API from inside Legcord.

## Install

1. Copy this `legcord-dvm-bridge` folder into Legcord's runtime plugin folder:
   - Windows: `%APPDATA%\Legcord\plugins\legcord-dvm-bridge`
2. Restart Legcord.
3. Open Legcord's Plugins settings and enable `Discord Volume Mixer Bridge` if it is listed.
4. In the Stream Deck plugin settings, leave `Client ID` and `Client secret` empty when using Legcord.

The bridge only listens on `127.0.0.1`.
