// [AGGIORNATO - MIMIC 2.0]
// Rimosse dipendenze da planDecide e planDecompose.
// La logica Top-Down ora si affida alla memoria a lungo termine per mantenere
// la coerenza degli obiettivi macro senza frammentare l'esecuzione.

const {plan} = require("../bot_action/plan");
const {getStatus, actAndFeedback} = require("./client");
const {sendMessage} = require("./sendMessage");

const BOT_LOG_MSG = "bridge.topDownActions:log";
const BOT_ERR_MSG ="bridge.topDownActions:error";

// Funzione per mettere in pausa il bot (sincronizzazione server e rate limit API)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- VARIABILI GLOBALI PER LA MEMORIA TOP-DOWN ---
let lastTopTaskDone = null;
let lastTopFeedbackRcvd = null;
let lastTopStatusRcvd = null;

/**
 * Esegue le azioni con approccio strategico (Top-Down) usando MIMIC 2.0.
 */
async function topDownActions(socket, skillManager, memoryStream,
                              PERSONALITY, RETRIEVE_IS_BOTH,
                              SKILL_ROOT_PATH,
                              TIMEOUT) {

    // 1. ACQUISIZIONE STATO PRECEDENTE
    const previousStatus = await getStatus(socket)
        .then(response => response)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Error when fetching status: ${error}`);
            return null;
        });

    if (!previousStatus) return null;

    sendMessage(socket, `${BOT_LOG_MSG} Previous Status Fetched.`);

    // 2. IL MEGA-PROMPT (Generazione Azione Strategica)
    // Usiamo il mode "topDown" per istruire Gemini a mantenere una visione a lungo termine
    const megaPlan = await plan(
        socket, memoryStream, previousStatus, PERSONALITY,
        [], // latestBadPlans deprecati
        lastTopTaskDone, lastTopFeedbackRcvd,
        RETRIEVE_IS_BOTH, "topDown"
    );

    if (!megaPlan || !megaPlan.nextAction) {
        sendMessage(socket, `${BOT_ERR_MSG} Top-Down Plan is NULL.`);
        return null;
    }

    const myPlan = megaPlan.nextAction;
    const memoryUpdate = megaPlan.memoryUpdate;

    // 3. AGGIORNAMENTO MEMORIA (Riflessione sul macro-obiettivo precedente)
    if (lastTopTaskDone && memoryUpdate && lastTopStatusRcvd) {
        let isError = (lastTopFeedbackRcvd && lastTopFeedbackRcvd.includes("Error"));
        let memoryType = isError ? "error" : "event";
        let errMsg = isError ? lastTopFeedbackRcvd : "";
        let mapStatusString = JSON.stringify(lastTopStatusRcvd);

        await memoryStream.addMemory(
            memoryType,
            memoryUpdate.success,
            Date.now(),
            0,
            Date.now(),
            lastTopTaskDone,
            myPlan.action,                      // Registriamo l'azione atomica
            JSON.stringify(myPlan.tile),        // E la destinazione
            myPlan.item1 || "null",
            myPlan.item2 || "null",
            mapStatusString,
            memoryUpdate.reasoning,             // Analisi soggettiva del successo/fallimento
            "",
            "",
            "",
            "",
            memoryUpdate.critique || "",
            errMsg
        );
        sendMessage(socket, `${BOT_LOG_MSG} Top-Down Memory Saved properly for macro-task: ${lastTopTaskDone}`);
    }

    // 4. ESECUZIONE DELL'AZIONE ATOMICA
    // Nota: Non decomponiamo più. Eseguiamo un passo alla volta verso il macro-obiettivo.
    const feedback = await actAndFeedback(socket, myPlan)
        .then(response => response)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Error when acting: ${error}`);
            return { logs: "", errors: "Error occurred" };
        });

    sendMessage(socket, `${BOT_LOG_MSG} Feedback received: ${JSON.stringify(feedback)}`);

    // 5. PREPARAZIONE PER IL PROSSIMO TURNO STRATEGICO
    lastTopTaskDone = myPlan.task;
    lastTopFeedbackRcvd = (feedback.errors && feedback.errors !== "") ? feedback.errors : feedback.logs;
    lastTopStatusRcvd = previousStatus;

    // Pausa di sicurezza
    await sleep(2000);

    // Ritorniamo un array con la singola azione per mantenere compatibilità con eventuali loop esterni
    return [myPlan];
}

module.exports = {
    topDownActions,
};