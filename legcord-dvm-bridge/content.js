(() => {
    const CONTENT_SOURCE = "dvm-legcord-content";
    const PAGE_SOURCE = "dvm-legcord-page";
    const BRIDGE_URL = "ws://127.0.0.1:6888";

    let socket = null;
    let reconnectTimer = null;

    function injectPageBridge() {
        const parent = document.documentElement || document.head || document.body;
        if (!parent) {
            setTimeout(injectPageBridge, 50);
            return;
        }

        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("page.js");
        script.onload = () => script.remove();
        parent.appendChild(script);
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, 1000);
    }

    function sendToPage(packet) {
        window.postMessage({
            source: CONTENT_SOURCE,
            type: "command",
            packet,
        }, "*");
    }

    function connect() {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

        socket = new WebSocket(BRIDGE_URL);
        socket.addEventListener("open", () => {
            sendToPage({ cmd: "AUTHENTICATE", nonce: "legcord_socket_hello", args: {} });
        });
        socket.addEventListener("message", (event) => {
            try {
                sendToPage(JSON.parse(event.data));
            } catch (_error) {
                // Ignore malformed local bridge messages.
            }
        });
        socket.addEventListener("close", () => {
            socket = null;
            scheduleReconnect();
        });
        socket.addEventListener("error", () => {
            if (socket) socket.close();
        });
    }

    window.addEventListener("message", (event) => {
        if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE) return;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(event.data.message));
    });

    injectPageBridge();
    connect();
})();
