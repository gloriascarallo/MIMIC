// [AGGIORNATO - MIMIC 2.0 Resilience Edition]
// Gestione ottimizzata dell'environment, memoria causale allineata e protezione Rate Limit.

const { plan } = require("../bot_action/plan");
const { getStatus, actAndFeedback } = require("./client");
const { sendMessage } = require("./sendMessage");

const BOT_LOG_MSG = "bridge.bottomUpActions:log";
const BOT_ERR_MSG = "bridge.bottomUpActions:error";

// Funzione per mettere in pausa il bot (stabilità API e sincronizzazione)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Variabili globali per la continuità turn-by-turn e memoria causale
let lastTaskDone = null;
let lastActionDone = null;
let lastTileDone = null;
let lastItem1Done = null;
let lastItem2Done = null;
let lastFeedbackRcvd = null;
let lastStatusRcvd = null;
let localBadPlans = []; // Memoria errori locale anti-loop

/**
 * Esegue le azioni reattive (Bottom-Up) del bot.
 */
async function bottomUpActions(socket, skillManager, memoryStream,
                               PERSONALITY, RETRIEVE_IS_BOTH,
                               TIMEOUT) {

    // 1. RECUPERO DELLO STATO CORRENTE
    const currentStatus = await getStatus(socket)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Errore nel fetching status: ${error}`);
            return null;
        });

    if (!currentStatus) return null;

    sendMessage(socket, `${BOT_LOG_MSG} Stato acquisito (Environment gestito dal client).`);

    // 2. CHIAMATA AL MEGA-PROMPT (Architettura Single-Shot)
    const megaPlan = await plan(
        socket, memoryStream, currentStatus, PERSONALITY,
        localBadPlans,
        lastTaskDone, lastFeedbackRcvd,
        RETRIEVE_IS_BOTH, "bottomUp"
    );

    // Se l'API restituisce un errore (Quota Exceeded 429 o Service Unavailable 503)
    if (!megaPlan || !megaPlan.nextAction) {
        const cooldown = 40000;
        sendMessage(socket, `${BOT_ERR_MSG} API Busy o Quota esaurita. Pausa di ${cooldown/1000}s...`);
        await sleep(cooldown);
        return null;
    }

    const nextAction = megaPlan.nextAction;
    const memoryUpdate = megaPlan.memoryUpdate;

    // 3. AGGIORNAMENTO MEMORIA SOGGETTIVA (Allineamento Causale)
    if (lastTaskDone && memoryUpdate && lastStatusRcvd) {
        const isError = lastFeedbackRcvd && (lastFeedbackRcvd.includes("Error") || lastFeedbackRcvd.includes("no path"));
        const memoryType = isError ? "error" : "event";
        const errMsg = isError ? lastFeedbackRcvd : "";

        await memoryStream.addMemory(
            memoryType,
            memoryUpdate.success,
            Date.now(),
            0,
            Date.now(),
            lastTaskDone,
            lastActionDone, // Azione che ha causato il risultato
            lastTileDone,   // Tile puntato nel turno precedente
            lastItem1Done,  // Item 1 del turno precedente
            lastItem2Done,  // Item 2 del turno precedente
            JSON.stringify(lastStatusRcvd),
            memoryUpdate.reasoning,
            "", "", "", "",
            memoryUpdate.critique || "",
            errMsg
        );
        sendMessage(socket, `${BOT_LOG_MSG} Memoria salvata per: ${lastTaskDone}`);
    }

    // 4. ESECUZIONE AZIONE
    const feedback = await actAndFeedback(socket, nextAction)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Errore durante l'azione: ${error}`);
            return { logs: "", errors: "Errore di connessione durante l'azione" };
        });

    sendMessage(socket, `${BOT_LOG_MSG} Feedback ricevuto dal server.`);

    // 5. PREPARAZIONE PER IL TURNO SUCCESSIVO (Salvataggio dati attuali)
    lastTaskDone = nextAction.task;
    lastActionDone = nextAction.action || "";
    lastTileDone = JSON.stringify(nextAction.tile || []);
    lastItem1Done = nextAction.item1 || "null";
    lastItem2Done = nextAction.item2 || "null";

    lastFeedbackRcvd = (feedback.errors && feedback.errors !== "") ? feedback.errors : feedback.logs;
    lastStatusRcvd = currentStatus;

    // --- SALVATAGGIO DEI BAD PLANS ---
    if (feedback.errors && feedback.errors !== "") {
        localBadPlans.push({
            badPlanSummary: () => `Task: '${nextAction.task}' failed because: ${feedback.errors}`
        });

        if (localBadPlans.length > 3) {
            localBadPlans.shift();
        }
    } else {
        localBadPlans = [];
    }

    // --- GESTIONE DINAMICA DEL RITMO (PROTEZIONE QUOTA) ---
    let finalSleep = 6000;

    if (lastFeedbackRcvd.includes("429") || lastFeedbackRcvd.includes("Quota")) {
        finalSleep = 45000;
        sendMessage(socket, `${BOT_LOG_MSG} [RATE LIMIT] Cooldown lungo attivato.`);
    }

    sendMessage(socket, `${BOT_LOG_MSG} Turno finito. Attesa: ${finalSleep/1000}s`);
    await sleep(finalSleep);

    return megaPlan;
}

module.exports = {
    bottomUpActions,
};