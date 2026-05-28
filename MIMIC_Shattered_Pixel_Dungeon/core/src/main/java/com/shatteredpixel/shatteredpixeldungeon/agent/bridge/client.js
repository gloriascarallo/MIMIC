const {sendMessage} = require("./sendMessage");

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
            sendMessage(socket, "GetStatus");
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
            sendMessage(socket, `ACTION: ${JSON.stringify(plan)}`);
        }, 20000);
    });
}

/**
 * Ottimizza e filtra lo stato per risparmiare token (Anti-429)
 */
/**
 * Convert the status to a prompt - Versione Robust (Anti-Crash)
 */
function status2Prompt(status, prefix="") {
    if (!status) return "Nessuno stato disponibile.";

    let res = "";

    const tokenSaver = (key, value) => {
        if (key === "description" || key === "name") return undefined;
        return value;
    };

    // Hero Status
    res += `${prefix}HP: ${status.health}/${status.maxHealth} | Lvl: ${status.level} | Pos: [${status.heroPositionInXY}]\n`;
    res += `${prefix}Gold: ${status.gold} | Depth: ${status.depth}\n`;

    // --- FIX PER L'INVENTARIO ---
    // Se status.items è un oggetto, usiamo Object.values() per renderlo un array
    const rawItems = status.items || {};
    const itemsArray = Array.isArray(rawItems) ? rawItems : Object.values(rawItems);

    const invNames = itemsArray.map(i => {
        const keys = Object.keys(i);
        // Filtriamo tutte le chiavi tecniche per trovare il vero nome dell'oggetto
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
        // Gestiamo anche l'environment se fosse un oggetto
        const envArray = Array.isArray(status.environment) ? status.environment : Object.values(status.environment);

        const crucialEnv = envArray.filter(tile => {
            const tileStr = JSON.stringify(tile).toLowerCase();

            // Nascondi le porte già aperte
            if (tileStr.includes("open_door")) {
                return false; // Se è aperta, scartala dal radar!
            }

            // 2. LA LISTA DI COSA PUÒ VEDERE L'IA
            return tileStr.includes("mob") ||
                tileStr.includes("door") ||       // Prenderà "door" e "locked_door", ma non "open_door"
                tileStr.includes("chest") ||
                tileStr.includes("trap") ||
                tileStr.includes("stairs") ||
                tileStr.includes("locked_stairs") ||
                tileStr.includes("guerriero");
        });

        res += `${prefix}Environment (Crucial): ${JSON.stringify(crucialEnv.slice(0, 15), tokenSaver)}\n`;
    }

    return res;
}

module.exports = {
    getStatus,
    status2Prompt,
    actAndFeedback,
    runAndFeedback: actAndFeedback, // Spesso sono identici nel bridge
};