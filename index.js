import config from "./config.json";
import Bun from "bun";

const requestsByIp = {};
const clients = [];

const checkboxesFile = Bun.file("checkboxes.json");
const checkboxesData = await checkboxesFile.exists() ? await checkboxesFile.json() : { length: config.checkboxes, checkboxes: new Array(config.checkboxes).fill(0) }; // Reads checkboxes.json file if exists else new object
if (checkboxesData.length !== config.checkboxes || checkboxesData.checkboxes.length != config.checkboxes) {
    // If amount of checkboxes don't match the amount set in config
    checkboxesData.length = config.checkboxes; // Change length
    // Slice/fill checkboxes
    checkboxesData.checkboxes = checkboxesData.checkboxes.length > config.checkboxes
        ? checkboxesData.checkboxes.slice(0, config.checkboxes) // Remove extra checkboxes
        : [...checkboxesData.checkboxes, ...new Array(config.checkboxes - checkboxesData.checkboxes.length).fill(0)]; // Add more checkboxes
}

// Serve HTTP server
Bun.serve({
    port: config.port,
    hostname: config.hostname,
    tls: (config.key && config.cert) ? {
        key: Bun.file(config.key),
        cert: Bun.file(config.cert)
    } : undefined,

    async fetch(req, server) {
        // Constant responses

        const method = req.method;
        const url = new URL(req.url);

        // /
        if (url.pathname == "/" && method == "GET") return new Response(Bun.file("index.html"));
        // /ws
        if (url.pathname == "/ws") return server.upgrade(req) ? null : error;

        // 404
        return new Response(null, { status: 301, headers: { Location: "/" } });
    },
    websocket: {
        open(ws) {
            ws.send(JSON.stringify({ type: "hello", data: { heartbeatInterval: config.heartbeatInterval, checkboxesData } })); // Send hello event with heartbeat interval
            ws.heartbeatSendInterval = setInterval(() => ws.send(JSON.stringify({ type: "heartbeat" })), config.heartbeatInterval); // Create interval to send heartbeats
            ws.heartbeatTimeout = setTimeout(() => ws.close(), config.heartbeatInterval + config.heartbeatIntervalDiff); // Create timeout to close if no heartbeats received
            clients.push(ws); // Push client to array
        },
        message(ws, message) {
            // Apply rate limit here
            if (requestsByIp[ws.remoteAddress]) {
                if (requestsByIp[ws.remoteAddress] >= config.rateLimit.maxRequests) {
                    // If hit rate limit, send message and close
                    return ws.send(JSON.stringify({ type: "rate-limited", failure: true, failureMessage: `You are being rate limited, try again in ${Math.ceil(config.rateLimit.decrementInterval / 1000)} seconds!` }));
                }
                // Increment requests
                requestsByIp[ws.remoteAddress]++;
            } else requestsByIp[ws.remoteAddress] = 1;

            let json;
            try { json = JSON.parse(message) } catch (err) { };
            if (!json) return;

            if (json.type == "heartbeat") {
                clearTimeout(ws.heartbeatTimeout);
                ws.heartbeatTimeout = setTimeout(() => ws.close(), config.heartbeatInterval + config.heartbeatIntervalDiff);
            } else
            if (json.type == "set-checkbox") {
                if (!json.data?.checkbox || json.data?.state == undefined) return;
                updateCheckbox(json.data.checkbox, json.data.state ? 1 : 0);
            }
        },
        close(ws) {
            clearInterval(ws.heartbeatInterval);
            clearTimeout(ws.heartbeatTimeout);
            const clientIndex = clients.findIndex(i => i == ws);
            if (clientIndex != -1) clients.splice(clientIndex, 1);
        }
    }
});

// Send message to all clients when a checkbox has been changed
function updateCheckbox(checkbox, state) {
    state = state ? 1 : 0;
    checkboxesData.checkboxes[checkbox] = state;
    clients.forEach(client => client.send(JSON.stringify({ type: "checkbox-update", data: { checkbox, state } })));
}

// Save checkboxes data to checkboxes.json every x milliseconds
setInterval(() => {
    Bun.write(checkboxesFile, JSON.stringify(checkboxesData));
}, config.saveInterval);

// Decrement requests in rate limits
setInterval(() => {
    for (const i in requestsByIp) {
        requestsByIp[i]--;
        if (requestsByIp[i] <= 0) delete requestsByIp[i];
    }
}, config.rateLimit.decrementInterval);