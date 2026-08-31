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

    // --- FIX 1: TROVARE LA POSIZIONE DEL GUERRIERO ---
    let heroPos = status["hero position in xy"];

    // Se il gioco non passa la variabile, la cerchiamo noi spulciando l'ambiente!
    if (!heroPos && status.environment) {
        const envArray = Array.isArray(status.environment) ? status.environment : Object.values(status.environment);
        for (let tile of envArray) {
            let key = Object.keys(tile)[0];
            if (key && key.toLowerCase().includes("guerriero")) {
                heroPos = tile[key]; // Estrae le coordinate [x, y] esatte
                break;
            }
        }
    }

    // Se dopo la ricerca heroPos è un array, lo uniamo in stringa per la memoria spaziale
    let posStrForMemory = "undefined";
    if (heroPos) {
        posStrForMemory = Array.isArray(heroPos) ? heroPos.join(", ") : heroPos;
    }

    // ---> Aggiorniamo la memoria spaziale <---
    if (status.depth !== undefined && posStrForMemory !== "undefined") {
        if (status.depth !== currentDepth) {
            visitedTiles.clear();
            currentDepth = status.depth;
        }
        visitedTiles.add(`[${posStrForMemory}]`);
    }
    // ---------------------------------------------------------------------------------

    // Hero Status (Ora mostrerà la posizione vera al posto di undefined!)
    res += `${prefix}HP: ${status.health}/${status.maxHealth} | Lvl: ${status.level} | Pos: [${posStrForMemory}]\n`;
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
            // FIX: Se la casella non contiene "null" significa che c'è un mostro o un oggetto!
            const hasEntity = !tileStr.includes("null)") && !tileStr.includes("null]");

            return hasEntity || // <--- Ora vedrà tutti i mostri e gli oggetti!
                tileStr.includes("door") ||
                tileStr.includes("chest") ||
                tileStr.includes("trap") ||
                tileStr.includes("stairs") ||
                tileStr.includes("locked_stairs") ||
                tileStr.includes("guerriero") ||
                tileStr.includes("boundary") ||
                tileStr.includes("empty_space") ||
                tileStr.includes("floor");
        });

        res += `${prefix}Environment (Crucial): ${JSON.stringify(crucialEnv.slice(0, 40), tokenSaver)}\n`;
    }

    // Stampiamo fisicamente la lista nel prompt finale
    let visitedArr = Array.from(visitedTiles).slice(-15);
    if (visitedArr.length > 0) {
        res += `${prefix}ALREADY VISITED TILES: ${visitedArr.join(" | ")}\n`;
    }

    // --- FIX 2: REGOLE FERREE PER IL MODELLO (Prompt Engineering) ---
    // Queste righe verranno lette da Llama 3.1 ad ogni turno, forzandolo a non fare errori
    res += `\n[CRITICAL RULES FOR NEXT ACTION]:\n`;
    res += `1. DO NOT move to your current 'Pos'. You are already there. Target a DIFFERENT walkable tile.\n`;
    res += `2. The 'tile' parameter MUST be a JSON array of two numbers, e.g., [20, 24]. NEVER use quotes around it like "[20, 24]".\n`;
    res += `3. COMBAT OVERRIDE: If any enemy in the Environment is marked as 'inRange', you MUST STOP EXPLORING. Your 'action' MUST be 'act', and your 'tile' MUST be the exact [x, y] coordinates of the enemy. Do not walk away or target empty spaces while an enemy is inRange.\n`;
    // NUOVA REGOLA PER SALVARE IL JSON:
    res += `4. STRICT JSON FORMAT: You MUST reply with EXACTLY ONE valid JSON object. Do not open a second JSON block, do not leave brackets unclosed, and do not add conversational text.\n`;
    res += `5. EXPLORATION OVERRIDE: If you receive a 'no path' error, DO NOT target the same boundary again. Instead, look for a normal '(door, null)' in the Environment and move to its exact coordinates to explore a new room. Avoid 'locked_door' unless you hold a key.\n`;
    res += `6. PROXIMITY OVERRIDE: Never target coordinates that are far away (where the difference between your position and the target is greater than 3 or 4 tiles). Only interact with adjacent or nearby tiles to avoid pathfinding errors.\n`;
    return res;
}

module.exports = {
    getStatus,
    status2Prompt,
    actAndFeedback,
    runAndFeedback: actAndFeedback,
};