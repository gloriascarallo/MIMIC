// [AGGIORNATO - MIMIC 2.0 Resilience Edition]
// Questo modulo gestisce lo switch intelligente tra reattività e strategia.
// Eredita la protezione Rate Limit dai moduli figli.

const { bottomUpActions } = require("./bottomUpActions");
const { topDownActions } = require("./topDownActions");
const { sendMessage } = require("./sendMessage");

const BOT_LOG_MSG = "bridge.hybridActions:log";

/**
 * Gestisce la logica ibrida del bot.
 */
async function hybridActions(socket, skillManager, memoryStream,
                             PERSONALITY,
                             RETRIEVE_IS_BOTH, SKILL_ROOT_PATH,
                             TIMEOUT,
                             cnt, isBottomUp = true,
                             switchCondition="S", thresholdD=20, thresholdS=30) {

    let changed = false;
    let actionPayload = null; // Variabile per salvare l'azione calcolata

    // 1. LOGICA DI SWITCH BASATA SULL'ESPERIENZA (S)
    // Se la memoria è sufficientemente popolata, passiamo a una visione più strategica.
    if (isBottomUp && (switchCondition === "S" || switchCondition === "H") &&
        (memoryStream.memoryCount >= thresholdS)) {

        // Lo switch avviene solo se non siamo già passati alla strategia.
        isBottomUp = false;
        changed = true;
        sendMessage(socket, `${BOT_LOG_MSG} [SWITCH] Memoria sufficiente (${memoryStream.memoryCount}). Passaggio a modalità STRATEGICA (Top-Down).`);
    }

    // 2. ESECUZIONE AZIONE
    if (isBottomUp) {
        // --- MODALITÀ REATTIVA ---
        let newActionObj = await bottomUpActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, TIMEOUT);
        actionPayload = newActionObj; // Salviamo il payload per agentClient

        // Leggiamo correttamente il task nidificato
        if (newActionObj && newActionObj.nextAction && newActionObj.nextAction.task) {
            // Se l'azione è valida, aggiorniamo il contatore di stasi (cnt)
            if (!memoryStream.hasTask(newActionObj.nextAction.task)) {
                cnt = 0;
            } else {
                cnt += 1;
            }
        }

    } else {
        // --- MODALITÀ STRATEGICA ---
        let subTask = await topDownActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, SKILL_ROOT_PATH, TIMEOUT);

        if (subTask && subTask.nextAction) {
            actionPayload = subTask; // Salviamo il payload per agentClient

            let taskString = subTask.nextAction.task || "";

            if (taskString) {
                if (!memoryStream.hasTask(taskString)) {
                    cnt = 0;
                } else {
                    cnt += 1;
                }
            }
        } else {
            // Se il topDown fallisce (es. per rate limit), evitiamo di incrementare il contatore di stasi inutilmente
            cnt = Math.max(0, cnt - 1);
        }
    }

    // 3. LOGICA DI SWITCH BASATA SULLA STASI (D)
    // Se il bot ripete lo stesso task troppo a lungo (es. incastrato contro un muro),
    // cambiamo approccio per forzare una nuova logica.
    if (!changed && (switchCondition === "D" || switchCondition === "H") && (cnt >= thresholdD)) {
        isBottomUp = !isBottomUp;
        cnt = 0;
        const mode = isBottomUp ? "REATTIVA (Bottom-Up)" : "STRATEGICA (Top-Down)";
        sendMessage(socket, `${BOT_LOG_MSG} [SWITCH] Rilevato loop/stasi. Cambiamento modalità in: ${mode}`);
    }

    // 4. RESTITUIAMO TUTTO AL CLIENT PRINCIPALE
    return {
        isBottomUp: isBottomUp,
        cnt: cnt,
        ...(actionPayload || {}) // Questo trasferisce l'azione e la memoria ad agentClient.js
    };
}

module.exports = {
    hybridActions,
};