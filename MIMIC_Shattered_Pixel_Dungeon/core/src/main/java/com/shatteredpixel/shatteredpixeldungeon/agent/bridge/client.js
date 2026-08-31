const {sendMessage} = require("./sendMessage");

// La memoria spaziale vive qui, al sicuro dai refresh
let visitedTiles = new Set();
let currentDepth = -1;
// -----------------------------------------------------------------------

/**
 * Get the status of the bot
 */
async function getStatus(socket) {
    sendMessage(socket, "GetStatus");

    return new Promise(function(resolve) {
        // Funzione handler per gestire il messaggio specifico
        const handler = (event) => {
            let msg = JSON.parse(event.data);
            if (msg.msgType === "status") {
                socket.removeEventListener('message', handler);
                clearTimeout(timeout);
                resolve(msg);
            }
        };

        socket.addEventListener('message', handler);

        let timeout = setTimeout(() => {
            socket.removeEventListener('message', handler);
            resolve({ msgType: "error", error: "Timeout GetStatus 20s" });
        }, 20000);
    });
}

/**
 * Send action request and get the feedback
 */
async function actAndFeedback(socket, plan) {
    sendMessage(socket, `ACTION: ${JSON.stringify(plan)}`);

    return new Promise(function(resolve) {
        const handler = (event) => {
            let msg = JSON.parse(event.data);
            if (msg.msgType === "feedback") {
                socket.removeEventListener('message', handler);
                clearTimeout(timeout);
                resolve(msg);
            }
        };

        socket.addEventListener('message', handler);

        let timeout = setTimeout(() => {
            socket.removeEventListener('message', handler);
            resolve({ msgType: "error", errors: "Timeout actAndFeedback 20s", logs: "" });
        }, 20000);
    });
}

/**
 * Convert the status to a prompt - Versione Robust (Anti-Crash & Anti-Loop)
 */
function status2Prompt(status, prefix="") {
    if (!status) return "Nessuno stato disponibile.";

    let res = "";

    const tokenSaver = (key, value) => {
        if (key === "description" || key === "name") return undefined;
        return value;
    };

    // ---> NOVITÀ: Aggiorniamo la memoria spaziale ogni volta che creiamo il prompt <---
    if (status.depth !== undefined && status["hero position in xy"]) {
        // Se scendiamo di livello, svuotiamo la memoria
        if (status.depth !== currentDepth) {
            visitedTiles.clear();
            currentDepth = status.depth;
        }

        // Estraiamo la posizione (gestendo sia array che stringhe per sicurezza)
        const posStr = Array.isArray(status["hero position in xy"])
            ? status["hero position in xy"].join(", ")
            : status["hero position in xy"];

        // Salviamo la coordinata
        visitedTiles.add(`[${posStr}]`);
    }
    // ---------------------------------------------------------------------------------

    // Hero Status
    res += `${prefix}HP: ${status.health}/${status.maxHealth} | Lvl: ${status.level} | Pos: [${status["hero position in xy"]}]\n`;
    res += `${prefix}Gold: ${status.gold} | Depth: ${status.depth}\n`;

    // --- FIX PER L'INVENTARIO ---
    const rawItems = status.items || {};
    const itemsArray = Array.isArray(rawItems) ? rawItems : Object.values(rawItems);

    const invNames = itemsArray.map(i => {
        const keys = Object.keys(i);
        const technicalKeys = ["quantity", "identified", "level", "STRReq", "category", "description", "name", "price", "identifiedName"];
        const realName = keys.find(k => !technicalKeys.includes(k));
        return realName || i.name || "oggetto_sconosciuto";
    });
    res += `${prefix}Inventory: ${invNames.join(", ")}\n`;

    // --- FIX PER L'EQUIPAGGIAMENTO ---
    const rawEquip = status.equipments || {};
    const equipArray = Array.isArray(rawEquip) ? rawEquip : Object.values(rawEquip);
    const equipNames = equipArray.map(e => e.name || "item");
    res += `${prefix}Equip: ${equipNames.join(", ")}\n`;

    // Environment filtrato (cruciale per i token)
    if (status.environment) {
        const envArray = Array.isArray(status.environment) ? status.environment : Object.values(status.environment);

        const crucialEnv = envArray.filter(tile => {
            const tileStr = JSON.stringify(tile).toLowerCase();
            if (tileStr.includes("open_door")) {
                return false;
            }
            return tileStr.includes("mob") ||
                tileStr.includes("door") ||
                tileStr.includes("chest") ||
                tileStr.includes("trap") ||
                tileStr.includes("stairs") ||
                tileStr.includes("locked_stairs") ||
                tileStr.includes("guerriero") ||
                tileStr.includes("boundary") ||
                tileStr.includes("empty_space") || // Vede dove camminare
                tileStr.includes("floor");         // Vede dove camminare
        });

        res += `${prefix}Environment (Crucial): ${JSON.stringify(crucialEnv.slice(0, 40), tokenSaver)}\n`;
    }

    //  Stampiamo fisicamente la lista nel prompt finale
    let visitedArr = Array.from(visitedTiles).slice(-15);
    if (visitedArr.length > 0) {
        res += `${prefix}ALREADY VISITED TILES: ${visitedArr.join(" | ")}\n`;
    }
    // ------------------------------------------------------------------

    return res;
}

module.exports = {
    getStatus,
    status2Prompt,
    actAndFeedback,
    runAndFeedback: actAndFeedback,
};