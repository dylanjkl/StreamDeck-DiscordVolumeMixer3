const http = require("node:http");

const HOST = "127.0.0.1";
const PORT = 6888;
const VERSION = "1.0.0";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENTS = 250;

let apiRef = null;
let server = null;
let refreshTimer = null;
let refreshInProgress = false;
let lastSnapshot = emptySnapshot();
let lastError = "";
let nextEventId = 1;
const events = [];

module.exports.activate = (api) => {
    apiRef = api;

    server = http.createServer((req, res) => {
        void handleRequest(req, res);
    });
    server.on("error", (error) => {
        api.logger.error("Failed to start bridge", error);
        lastError = String(error && error.message ? error.message : error);
    });
    server.listen(PORT, HOST, () => {
        api.logger.log(`listening on http://${HOST}:${PORT}`);
    });

    refreshTimer = setInterval(() => {
        void refreshSnapshot({ emitEvents: true });
    }, 750);
    void refreshSnapshot({ emitEvents: false });

    api.onCleanup(() => {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;

        if (server) server.close();
        server = null;
        apiRef = null;
        events.length = 0;
    });
};

function emptySnapshot() {
    return {
        ok: false,
        current_user: null,
        voice_settings: { mute: false, deaf: false },
        channel: { id: "", guild_id: "", voice_states: [] },
        speaking_user_ids: [],
    };
}

async function handleRequest(req, res) {
    try {
        const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

        if (req.method === "GET" && url.pathname === "/health") {
            await refreshSnapshot({ emitEvents: false });
            return sendJson(res, 200, {
                ok: true,
                name: "legcord-dvm-bridge",
                version: VERSION,
                ready: Boolean(lastSnapshot.ok && lastSnapshot.current_user && lastSnapshot.current_user.id),
                user_id: lastSnapshot.current_user ? lastSnapshot.current_user.id : "",
                last_event_id: nextEventId - 1,
                last_error: lastError,
            });
        }

        if (req.method === "GET" && url.pathname === "/events") {
            const after = Number(url.searchParams.get("after") || 0);
            const pendingEvents = events.filter((event) => event.id > after);
            return sendJson(res, 200, {
                ok: true,
                last_event_id: nextEventId - 1,
                events: pendingEvents,
            });
        }

        if (req.method === "POST" && url.pathname === "/rpc") {
            const packet = await readJsonBody(req);
            const response = await handleRpc(packet);
            return sendJson(res, 200, response);
        }

        return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        if (apiRef) apiRef.logger.warn("request failed", message);
        return sendJson(res, 500, { ok: false, error: message });
    }
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                req.destroy();
                reject(new Error("request body too large"));
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
    });
    res.end(body);
}

async function handleRpc(packet) {
    const cmd = String(packet && packet.cmd ? packet.cmd : "").toUpperCase();

    try {
        switch (cmd) {
            case "AUTHORIZE":
                return rpcOk(packet, { code: "legcord-dvm-bridge" });

            case "AUTHENTICATE": {
                const snapshot = await refreshSnapshot({ emitEvents: false });
                if (!snapshot.ok || !snapshot.current_user || !snapshot.current_user.id) {
                    return rpcError(packet, lastError || "Legcord Discord stores are not ready");
                }
                return rpcOk(packet, { user: snapshot.current_user });
            }

            case "SUBSCRIBE":
            case "UNSUBSCRIBE":
                return rpcOk(packet, null);

            case "GET_VOICE_SETTINGS": {
                const snapshot = await refreshSnapshot({ emitEvents: false });
                return rpcOk(packet, snapshot.voice_settings || { mute: false, deaf: false });
            }

            case "SET_VOICE_SETTINGS": {
                await runRendererFunction(setVoiceSettingsRenderer, packet.args || {});
                const snapshot = await refreshSnapshot({ emitEvents: true });
                return rpcOk(packet, snapshot.voice_settings || { mute: false, deaf: false });
            }

            case "GET_SELECTED_VOICE_CHANNEL": {
                const snapshot = await refreshSnapshot({ emitEvents: false });
                return rpcOk(packet, snapshot.channel || { id: "", guild_id: "", voice_states: [] });
            }

            case "SET_USER_VOICE_SETTINGS": {
                const args = packet.args || {};
                await runRendererFunction(setUserVoiceSettingsRenderer, args);
                const snapshot = await refreshSnapshot({ emitEvents: true });
                const userId = String(args.user_id || "");
                const updatedState = (snapshot.channel && snapshot.channel.voice_states || []).find((state) => {
                    return state && state.user && state.user.id === userId;
                });
                return rpcOk(packet, updatedState || null);
            }

            default:
                return rpcError(packet, `Unsupported command ${cmd || "(empty)"}`);
        }
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        lastError = message;
        return rpcError(packet, message);
    }
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

async function refreshSnapshot({ emitEvents }) {
    if (refreshInProgress) return lastSnapshot;

    refreshInProgress = true;
    try {
        const snapshot = await runRendererFunction(collectSnapshotRenderer);
        if (!snapshot || !snapshot.ok) {
            lastError = snapshot && snapshot.error ? snapshot.error : "Unable to read Legcord Discord stores";
            return lastSnapshot;
        }

        lastError = "";
        if (emitEvents && lastSnapshot && lastSnapshot.ok) {
            emitSnapshotDiff(lastSnapshot, snapshot);
        }
        lastSnapshot = snapshot;
        return lastSnapshot;
    } catch (error) {
        lastError = String(error && error.message ? error.message : error);
        return lastSnapshot;
    } finally {
        refreshInProgress = false;
    }
}

function emitSnapshotDiff(previous, next) {
    const previousChannelId = previous.channel && previous.channel.id || "";
    const nextChannelId = next.channel && next.channel.id || "";

    if (previousChannelId !== nextChannelId) {
        queueEvent("VOICE_CHANNEL_SELECT", { channel_id: nextChannelId });
    }

    const previousMembers = mapVoiceStates(previous.channel && previous.channel.voice_states);
    const nextMembers = mapVoiceStates(next.channel && next.channel.voice_states);

    for (const [userId, state] of nextMembers) {
        if (!previousMembers.has(userId)) {
            queueEvent("VOICE_STATE_CREATE", state);
        } else if (voiceStateChanged(previousMembers.get(userId), state)) {
            queueEvent("VOICE_STATE_UPDATE", state);
        }
    }

    for (const [userId, state] of previousMembers) {
        if (!nextMembers.has(userId)) {
            queueEvent("VOICE_STATE_DELETE", state);
        }
    }

    const previousSpeaking = new Set(previous.speaking_user_ids || []);
    const nextSpeaking = new Set(next.speaking_user_ids || []);

    for (const userId of nextSpeaking) {
        if (!previousSpeaking.has(userId)) {
            queueEvent("SPEAKING_START", { user_id: userId });
        }
    }
    for (const userId of previousSpeaking) {
        if (!nextSpeaking.has(userId)) {
            queueEvent("SPEAKING_STOP", { user_id: userId });
        }
    }

    const previousSettings = previous.voice_settings || {};
    const nextSettings = next.voice_settings || {};
    if (Boolean(previousSettings.mute) !== Boolean(nextSettings.mute) || Boolean(previousSettings.deaf) !== Boolean(nextSettings.deaf)) {
        queueEvent("VOICE_SETTINGS_UPDATE", {
            mute: Boolean(nextSettings.mute),
            deaf: Boolean(nextSettings.deaf),
        });
    }
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

function queueEvent(evt, data) {
    events.push({
        id: nextEventId++,
        message: {
            cmd: "DISPATCH",
            data,
            evt,
            nonce: null,
        },
    });

    if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
    }
}

function getCandidateWindows() {
    if (!apiRef) return null;

    const windows = apiRef.electron.BrowserWindow.getAllWindows();
    return windows.filter((win) => {
        return win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed();
    });
}

async function runRendererFunction(fn, ...args) {
    const windows = getCandidateWindows();
    if (!windows || !windows.length) throw new Error("No Legcord window is available");

    const script = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
    let lastFailure = "";
    for (const win of windows) {
        try {
            const result = await win.webContents.executeJavaScript(script, true);
            if (result && result.ok === false) {
                lastFailure = result.error || "Renderer stores are not available";
                continue;
            }
            return result;
        } catch (error) {
            lastFailure = String(error && error.message ? error.message : error);
        }
    }

    throw new Error(lastFailure || "No Legcord Discord renderer is available");
}

function collectSnapshotRenderer() {
    function uiToIPCVolume(volume) {
        if (volume <= 0) return 0;
        if (volume <= 100) return Math.exp((volume - 20.054) / 17.362);
        return Math.exp((volume + 567.21) / 144.86);
    }

    function readStore(name) {
        return stores && stores[name] || null;
    }

    function toPlainUser(user) {
        if (!user) return null;
        return {
            id: String(user.id || ""),
            username: String(user.username || user.globalName || user.id || ""),
            global_name: user.globalName || user.global_name || null,
            avatar: user.avatar || null,
            discriminator: user.discriminator || "0",
        };
    }

    function voiceStateUserId(state, fallback) {
        return String(state && (state.userId || state.user_id || state.user && state.user.id) || fallback || "");
    }

    function voiceStateChannelId(state) {
        return String(state && (state.channelId || state.channel_id) || "");
    }

    function boolValue(value) {
        return Boolean(value);
    }

    const shelterRef = globalThis.shelter;
    const stores = shelterRef && shelterRef.flux && shelterRef.flux.storesFlat;
    if (!stores) {
        return { ok: false, error: "shelter flux stores are not available" };
    }

    const selectedChannelStore = readStore("SelectedChannelStore");
    const voiceStateStore = readStore("VoiceStateStore");
    const userStore = readStore("UserStore");
    const guildMemberStore = readStore("GuildMemberStore");
    const channelStore = readStore("ChannelStore");
    const mediaEngineStore = readStore("MediaEngineStore");
    const channelRTCStore = readStore("ChannelRTCStore");
    const rtcConnectionStore = readStore("RTCConnectionStore");

    const currentUser = userStore && userStore.getCurrentUser ? userStore.getCurrentUser() : null;
    const currentUserId = currentUser && currentUser.id ? String(currentUser.id) : "";
    const settings = mediaEngineStore && mediaEngineStore.getSettings ? mediaEngineStore.getSettings("default") : {};

    let channelId = selectedChannelStore && selectedChannelStore.getVoiceChannelId ? selectedChannelStore.getVoiceChannelId() : "";
    if (!channelId && rtcConnectionStore && rtcConnectionStore.getChannelId) channelId = rtcConnectionStore.getChannelId();
    channelId = channelId ? String(channelId) : "";

    let channel = null;
    if (channelId && channelStore && channelStore.getChannel) channel = channelStore.getChannel(channelId);

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
        const userId = voiceStateUserId(state, fallbackUserId);
        if (!userId) continue;
        if (channelId && voiceStateChannelId(state) && voiceStateChannelId(state) !== channelId) continue;

        const user = userStore && userStore.getUser ? userStore.getUser(userId) : null;
        const plainUser = toPlainUser(user) || { id: userId, username: userId, global_name: null, avatar: null, discriminator: "0" };
        const nick = guildMemberStore && guildMemberStore.getNick ? guildMemberStore.getNick(guildId || null, userId) : "";
        const localVolume = mediaEngineStore && mediaEngineStore.getLocalVolume ? mediaEngineStore.getLocalVolume(userId, "default") : 100;
        const localMute = mediaEngineStore && mediaEngineStore.isLocalMute ? mediaEngineStore.isLocalMute(userId, "default") : false;

        voiceStates.push({
            nick: nick || plainUser.global_name || plainUser.username || userId,
            user: plainUser,
            volume: uiToIPCVolume(Number.isFinite(localVolume) ? localVolume : 100),
            mute: boolValue(localMute),
            channel_id: channelId,
            guild_id: guildId,
            voice_state: {
                self_mute: boolValue(state && (state.selfMute || state.self_mute)),
                self_deaf: boolValue(state && (state.selfDeaf || state.self_deaf)),
                mute: boolValue(state && state.mute),
                deaf: boolValue(state && state.deaf),
            },
        });
    }

    let speakingUserIds = [];
    if (channelId && channelRTCStore && channelRTCStore.getSpeakingParticipants) {
        const speaking = channelRTCStore.getSpeakingParticipants(channelId) || [];
        speakingUserIds = Array.from(speaking).map((participant) => {
            return String(participant && (participant.userId || participant.id || participant.user && participant.user.id) || "");
        }).filter(Boolean);
    }

    return {
        ok: true,
        current_user: toPlainUser(currentUser) || { id: currentUserId, username: currentUserId, global_name: null, avatar: null, discriminator: "0" },
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

function setVoiceSettingsRenderer(args) {
    const shelterRef = globalThis.shelter;
    const flux = shelterRef && shelterRef.flux;
    const stores = flux && flux.storesFlat;
    const mediaEngineStore = stores && stores.MediaEngineStore;
    const dispatcher = flux && flux.dispatcher;
    if (!mediaEngineStore) throw new Error("MediaEngineStore is not available");

    function currentMute() {
        if (mediaEngineStore.isSelfMute) return Boolean(mediaEngineStore.isSelfMute("default"));
        const settings = mediaEngineStore.getSettings ? mediaEngineStore.getSettings("default") : {};
        return Boolean(settings && settings.mute);
    }

    function currentDeaf() {
        if (mediaEngineStore.isSelfDeaf) return Boolean(mediaEngineStore.isSelfDeaf("default"));
        const settings = mediaEngineStore.getSettings ? mediaEngineStore.getSettings("default") : {};
        return Boolean(settings && settings.deaf);
    }

    if (Object.prototype.hasOwnProperty.call(args, "mute")) {
        const mute = Boolean(args.mute);
        if (mediaEngineStore.setSelfMute) {
            mediaEngineStore.setSelfMute(mute);
        } else if (dispatcher && currentMute() !== mute) {
            dispatcher.dispatch({ type: "AUDIO_TOGGLE_SELF_MUTE", context: "default", syncRemote: true, playSoundEffect: true });
        }
    }

    if (Object.prototype.hasOwnProperty.call(args, "deaf")) {
        const deaf = Boolean(args.deaf);
        if (mediaEngineStore.setSelfDeaf) {
            mediaEngineStore.setSelfDeaf(deaf);
        } else if (dispatcher && currentDeaf() !== deaf) {
            dispatcher.dispatch({ type: "AUDIO_TOGGLE_SELF_DEAF", context: "default", syncRemote: true });
        }
    }

    return true;
}

function setUserVoiceSettingsRenderer(args) {
    function ipcToUIVolume(volume) {
        if (volume <= 0) return 0;
        if (volume <= 100) return 17.362 * Math.log(volume) + 20.054;
        return 144.86 * Math.log(volume) - 567.21;
    }

    const shelterRef = globalThis.shelter;
    const stores = shelterRef && shelterRef.flux && shelterRef.flux.storesFlat;
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

    return true;
}
