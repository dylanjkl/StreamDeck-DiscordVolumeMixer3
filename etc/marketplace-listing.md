# Marketplace listing — Discord Volume Mixer 3

Reference for submitting to the Elgato Marketplace via the Maker Console
(https://maker.elgato.com). Not part of the built plugin.

## Description (paste into Maker Console — keep under 1500 characters)

Discord Volume Mixer 3 turns your Stream Deck into a live mixing board for Discord voice chat. See everyone in your voice channel and adjust each person's volume independently — perfect for taming loud friends, boosting quiet teammates, and balancing your party without ever alt-tabbing out of your game.

Features:
- Per-user volume control via buttons or Stream Deck + dials
- Mute or unmute any user with a single tap
- Live "speaking" indicators and user avatars
- Self mute & deafen buttons
- Paging for large voice channels
- Works on Standard, Mini, XL, Mobile, and Stream Deck +
- Supports both the Discord desktop app and Legcord (via the bundled bridge)

A maintained, optimized fork of CZDanol's Discord Volume Mixer 2 — with crash fixes, faster button updates, smarter avatar loading, and clearer connection status.

Requires Stream Deck 7.4 or newer on Windows 10/11 (64-bit). Free and open source (GPL-3.0).

Not affiliated with or endorsed by Discord Inc.

## Submission checklist

- [ ] Create your organization + sign the Maker Agreement
- [ ] Final UUID decided (immutable after publishing; convention is 3-segment, e.g. `com.dylanjkl.discordmixer`)
- [ ] Tested on real Stream Deck hardware (Discord OAuth + Legcord + the bug fixes)
- [ ] Thumbnail image + at least 3 gallery screenshots (start from etc/sshot*.png)
- [ ] Description above (<= 1500 chars)
- [ ] Price: Free
- [ ] Product file: `dylanjkl.discordmixer.streamDeckPlugin` from `streamdeck pack`
