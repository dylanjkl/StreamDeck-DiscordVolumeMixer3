(() => {
    if (window.__DVM_LEGCORD_PAGE_BRIDGE__) return;
    window.__DVM_LEGCORD_PAGE_BRIDGE__ = true;

    const CONTENT_SOURCE = "dvm-legcord-content";
    const PAGE_SOURCE = "dvm-legcord-page";

    let lastSnapshot = null;

    // Transport is owned by content.js (extension context, exempt from Discord's page CSP). We relay
    // exclusively via postMessage; page.js no longer opens its own socket, which previously double-sent
    // every event and fought content.js for the bridge's single allowed connection.
    function post(message) {
        window.postMessage({ source: PAGE_SOURCE, message }, "*");
    }

    function rpcOk(packet, data) {
        return {
            cmd: packet.cmd || "",
            data,
            evt: packet.evt || null,
            nonce: packet.nonce || null,
        };
    }

    function rpcError(packet, message) {
        return {
            cmd: packet && packet.cmd || "",
            data: { message },
            evt: "ERROR",
            nonce: packet && packet.nonce || null,
        };
    }

    function uiToIPCVolume(volume) {
        if (volume <= 0) return 0;
        if (volume <= 100) return Math.exp((volume - 20.054) / 17.362);
        return Math.exp((volume + 567.21) / 144.86);
    }

    function ipcToUIVolume(volume) {
        if (volume <= 0) return 0;
        if (volume <= 100) return 17.362 * Math.log(volume) + 20.054;
        return 144.86 * Math.log(volume) - 567.21;
    }

    function collectSnapshot() {
        const shelterRef = window.shelter;
        const stores = shelterRef && shelterRef.flux && shelterRef.flux.storesFlat;
        if (!stores) return { ok: false, error: "shelter flux stores are not available" };

        const selectedChannelStore = stores.SelectedChannelStore;
        const voiceStateStore = stores.VoiceStateStore;
        const userStore = stores.UserStore;
        const guildMemberStore = stores.GuildMemberStore;
        const channelStore = stores.ChannelStore;
        const mediaEngineStore = stores.MediaEngineStore;
        const channelRTCStore = stores.ChannelRTCStore;
        const rtcConnectionStore = stores.RTCConnectionStore;

        const currentUser = userStore && userStore.getCurrentUser ? userStore.getCurrentUser() : null;
        const settings = mediaEngineStore && mediaEngineStore.getSettings ? mediaEngineStore.getSettings("default") : {};

        let channelId = selectedChannelStore && selectedChannelStore.getVoiceChannelId ? selectedChannelStore.getVoiceChannelId() : "";
        if (!channelId && rtcConnectionStore && rtcConnectionStore.getChannelId) channelId = rtcConnectionStore.getChannelId();
        channelId = channelId ? String(channelId) : "";

        const channel = channelId && channelStore && channelStore.getChannel ? channelStore.getChannel(channelId) : null;
        let guildId = channel && (channel.guild_id || channel.guildId) || "";
        if (!guildId && rtcConnectionStore && rtcConnectionStore.getGuildId) guildId = rtcConnectionStore.getGuildId() || "";
        guildId = guildId ? String(guildId) : "";

        let rawVoiceStates = {};
        if (channelId && voiceStateStore && voiceStateStore.getVoiceStatesForChannel) {
            rawVoiceStates = voiceStateStore.getVoiceStatesForChannel(channelId) || {};
        } else if (voiceStateStore && voiceStateStore.getVoiceStates) {
            rawVoiceStates = voiceStateStore.getVoiceStates(guildId || null) || {};
        }

        const voiceStates = [];
        for (const [fallbackUserId, state] of Object.entries(rawVoiceStates || {})) {
            const userId = String(state && (state.userId || state.user_id || state.user && state.user.id) || fallbackUserId || "");
            const stateChannelId = String(state && (state.channelId || state.channel_id) || "");
            if (!userId) continue;
            if (channelId && stateChannelId && stateChannelId !== channelId) continue;

            const user = userStore && userStore.getUser ? userStore.getUser(userId) : null;
            const plainUser = user ? {
                id: String(user.id || userId),
                username: String(user.username || user.globalName || user.id || userId),
                global_name: user.globalName || user.global_name || null,
                avatar: user.avatar || null,
                discriminator: user.discriminator || "0",
            } : {
                id: userId,
                username: userId,
                global_name: null,
                avatar: null,
                discriminator: "0",
            };

            const nick = guildMemberStore && guildMemberStore.getNick ? guildMemberStore.getNick(guildId || null, userId) : "";
            const localVolume = mediaEngineStore && mediaEngineStore.getLocalVolume ? mediaEngineStore.getLocalVolume(userId, "default") : 100;
            const localMute = mediaEngineStore && mediaEngineStore.isLocalMute ? mediaEngineStore.isLocalMute(userId, "default") : false;

            voiceStates.push({
                nick: nick || plainUser.global_name || plainUser.username || userId,
                user: plainUser,
                volume: uiToIPCVolume(Number.isFinite(localVolume) ? localVolume : 100),
                mute: Boolean(localMute),
                channel_id: channelId,
                guild_id: guildId,
                voice_state: {
                    self_mute: Boolean(state && (state.selfMute || state.self_mute)),
                    self_deaf: Boolean(state && (state.selfDeaf || state.self_deaf)),
                    mute: Boolean(state && state.mute),
                    deaf: Boolean(state && state.deaf),
                },
            });
        }

        let speakingUserIds = [];
        if (channelId && channelRTCStore && channelRTCStore.getSpeakingParticipants) {
            speakingUserIds = Array.from(channelRTCStore.getSpeakingParticipants(channelId) || []).map((participant) => {
                return String(participant && (participant.userId || participant.id || participant.user && participant.user.id) || "");
            }).filter(Boolean);
        }

        return {
            ok: true,
            current_user: currentUser ? {
                id: String(currentUser.id || ""),
                username: String(currentUser.username || currentUser.globalName || currentUser.id || ""),
                global_name: currentUser.globalName || currentUser.global_name || null,
                avatar: currentUser.avatar || null,
                discriminator: currentUser.discriminator || "0",
            } : { id: "", username: "", global_name: null, avatar: null, discriminator: "0" },
            voice_settings: {
                mute: mediaEngineStore && mediaEngineStore.isSelfMute ? Boolean(mediaEngineStore.isSelfMute("default")) : Boolean(settings && settings.mute),
                deaf: mediaEngineStore && mediaEngineStore.isSelfDeaf ? Boolean(mediaEngineStore.isSelfDeaf("default")) : Boolean(settings && settings.deaf),
            },
            channel: {
                id: channelId,
                guild_id: guildId,
                voice_states: voiceStates,
            },
            speaking_user_ids: speakingUserIds,
        };
    }

    function mapVoiceStates(states) {
        const result = new Map();
        for (const state of states || []) {
            const userId = state && state.user && state.user.id;
            if (userId) result.set(userId, state);
        }
        return result;
    }

    // Compare only the fields the plugin actually consumes, instead of full JSON.stringify of every
    // member each tick (cheaper and immune to key-order differences).
    function voiceStateChanged(a, b) {
        if (!a || !b) return a !== b;
        const au = a.user || {}, bu = b.user || {};
        if (a.nick !== b.nick || a.volume !== b.volume || Boolean(a.mute) !== Boolean(b.mute) || au.avatar !== bu.avatar) return true;
        const av = a.voice_state || {}, bv = b.voice_state || {};
        return Boolean(av.self_mute) !== Boolean(bv.self_mute) || Boolean(av.self_deaf) !== Boolean(bv.self_deaf);
    }

    function dispatch(evt, data) {
        post({
            cmd: "DISPATCH",
            data,
            evt,
            nonce: null,
        });
    }

    function emitDiff(previous, next) {
        const previousChannelId = previous.channel && previous.channel.id || "";
        const nextChannelId = next.channel && next.channel.id || "";
        if (previousChannelId !== nextChannelId) dispatch("VOICE_CHANNEL_SELECT", { channel_id: nextChannelId });

        const previousMembers = mapVoiceStates(previous.channel && previous.channel.voice_states);
        const nextMembers = mapVoiceStates(next.channel && next.channel.voice_states);

        for (const [userId, state] of nextMembers) {
            if (!previousMembers.has(userId)) dispatch("VOICE_STATE_CREATE", state);
            else if (voiceStateChanged(previousMembers.get(userId), state)) dispatch("VOICE_STATE_UPDATE", state);
        }
        for (const [userId, state] of previousMembers) {
            if (!nextMembers.has(userId)) dispatch("VOICE_STATE_DELETE", state);
        }

        const previousSpeaking = new Set(previous.speaking_user_ids || []);
        const nextSpeaking = new Set(next.speaking_user_ids || []);
        for (const userId of nextSpeaking) if (!previousSpeaking.has(userId)) dispatch("SPEAKING_START", { user_id: userId });
        for (const userId of previousSpeaking) if (!nextSpeaking.has(userId)) dispatch("SPEAKING_STOP", { user_id: userId });

        const previousSettings = previous.voice_settings || {};
        const nextSettings = next.voice_settings || {};
        if (Boolean(previousSettings.mute) !== Boolean(nextSettings.mute) || Boolean(previousSettings.deaf) !== Boolean(nextSettings.deaf)) {
            dispatch("VOICE_SETTINGS_UPDATE", { mute: Boolean(nextSettings.mute), deaf: Boolean(nextSettings.deaf) });
        }
    }

    function setVoiceSettings(args) {
        const flux = window.shelter && window.shelter.flux;
        const stores = flux && flux.storesFlat;
        const mediaEngineStore = stores && stores.MediaEngineStore;
        const dispatcher = flux && flux.dispatcher;
        if (!mediaEngineStore) throw new Error("MediaEngineStore is not available");

        const currentMute = () => mediaEngineStore.isSelfMute ? Boolean(mediaEngineStore.isSelfMute("default")) : Boolean(mediaEngineStore.getSettings && mediaEngineStore.getSettings("default").mute);
        const currentDeaf = () => mediaEngineStore.isSelfDeaf ? Boolean(mediaEngineStore.isSelfDeaf("default")) : Boolean(mediaEngineStore.getSettings && mediaEngineStore.getSettings("default").deaf);

        if (Object.prototype.hasOwnProperty.call(args, "mute")) {
            const mute = Boolean(args.mute);
            if (mediaEngineStore.setSelfMute) mediaEngineStore.setSelfMute(mute);
            else if (dispatcher && currentMute() !== mute) dispatcher.dispatch({ type: "AUDIO_TOGGLE_SELF_MUTE", context: "default", syncRemote: true, playSoundEffect: true });
        }

        if (Object.prototype.hasOwnProperty.call(args, "deaf")) {
            const deaf = Boolean(args.deaf);
            if (mediaEngineStore.setSelfDeaf) mediaEngineStore.setSelfDeaf(deaf);
            else if (dispatcher && currentDeaf() !== deaf) dispatcher.dispatch({ type: "AUDIO_TOGGLE_SELF_DEAF", context: "default", syncRemote: true });
        }
    }

    function setUserVoiceSettings(args) {
        const stores = window.shelter && window.shelter.flux && window.shelter.flux.storesFlat;
        const mediaEngineStore = stores && stores.MediaEngineStore;
        if (!mediaEngineStore) throw new Error("MediaEngineStore is not available");

        const userId = String(args.user_id || "");
        if (!userId) throw new Error("user_id is required");

        if (Object.prototype.hasOwnProperty.call(args, "volume") && mediaEngineStore.setLocalVolume) {
            const ipcVolume = Number(args.volume);
            const uiVolume = Number.isFinite(ipcVolume) ? Math.max(0, Math.min(200, ipcToUIVolume(ipcVolume))) : 100;
            mediaEngineStore.setLocalVolume(userId, uiVolume);
        }
        if (Object.prototype.hasOwnProperty.call(args, "mute") && mediaEngineStore.setLocalMute) {
            mediaEngineStore.setLocalMute(userId, Boolean(args.mute));
        }
    }

    async function handleRpc(packet) {
        const cmd = String(packet && packet.cmd || "").toUpperCase();
        switch (cmd) {
            case "AUTHORIZE":
                return rpcOk(packet, { code: "legcord-dvm-extension-bridge" });
            case "AUTHENTICATE": {
                const snapshot = collectSnapshot();
                if (!snapshot.ok || !snapshot.current_user.id) return rpcError(packet, snapshot.error || "Discord stores are not ready");
                return rpcOk(packet, { user: snapshot.current_user });
            }
            case "SUBSCRIBE":
            case "UNSUBSCRIBE":
                return rpcOk(packet, null);
            case "GET_VOICE_SETTINGS":
                return rpcOk(packet, collectSnapshot().voice_settings || { mute: false, deaf: false });
            case "SET_VOICE_SETTINGS": {
                setVoiceSettings(packet.args || {});
                return rpcOk(packet, collectSnapshot().voice_settings || { mute: false, deaf: false });
            }
            case "GET_SELECTED_VOICE_CHANNEL":
                return rpcOk(packet, collectSnapshot().channel || { id: "", guild_id: "", voice_states: [] });
            case "SET_USER_VOICE_SETTINGS": {
                const args = packet.args || {};
                setUserVoiceSettings(args);
                const snapshot = collectSnapshot();
                const userId = String(args.user_id || "");
                const updatedState = (snapshot.channel && snapshot.channel.voice_states || []).find((state) => state && state.user && state.user.id === userId);
                return rpcOk(packet, updatedState || null);
            }
            default:
                return rpcError(packet, `Unsupported command ${cmd || "(empty)"}`);
        }
    }

    window.addEventListener("message", (event) => {
        if (event.source !== window || !event.data || event.data.source !== CONTENT_SOURCE || event.data.type !== "command") return;
        void handleRpc(event.data.packet || {}).then(post).catch((error) => {
            post(rpcError(event.data.packet || {}, String(error && error.message ? error.message : error)));
        });
    });

    // Single poll loop: diff the stores AND re-announce authentication. The re-auth was previously a
    // second interval that ran its own full store scan every 1s; folding it in halves the scan rate
    // while still letting a late-connecting bridge learn our user id.
    setInterval(() => {
        const snapshot = collectSnapshot();
        if (!snapshot.ok) return;
        if (lastSnapshot && lastSnapshot.ok) emitDiff(lastSnapshot, snapshot);
        lastSnapshot = snapshot;

        if (snapshot.current_user && snapshot.current_user.id) {
            post(rpcOk({ cmd: "AUTHENTICATE", nonce: "legcord_socket_hello" }, { user: snapshot.current_user }));
        }
    }, 750);
})();
