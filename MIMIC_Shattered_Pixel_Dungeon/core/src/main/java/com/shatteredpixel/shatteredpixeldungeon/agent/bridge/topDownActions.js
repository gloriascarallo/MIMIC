// [AGGIORNATO - MIMIC 2.0 Resilience Edition + Metrics Tracking]
// Gestione strategica ottimizzata, memoria causale allineata e protezione Rate Limit.

const { plan } = require("../bot_action/plan");
const { getStatus, actAndFeedback } = require("./client");
const { sendMessage } = require("./sendMessage");

// --- INIEZIONE PER LE METRICHE DELLA TESI ---
const { performance } = require('perf_hooks');
const { logTurn } = require('./metricsLogger'); // Assicurati che il percorso sia corretto
// --------------------------------------------

const BOT_LOG_MSG = "bridge.topDownActions:log";
const BOT_ERR_MSG ="bridge.topDownActions:error";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- VARIABILI GLOBALI PER LA MEMORIA TOP-DOWN CAUSALE ---
let lastTopTaskDone = null;
let lastTopActionDone = null;
let lastTopTileDone = null;
let lastTopItem1Done = null;
let lastTopItem2Done = null;
let lastTopFeedbackRcvd = null;
let lastTopStatusRcvd = null;
let topLocalBadPlans = [];

/**
 * Esegue le azioni con approccio strategico (Top-Down) usando MIMIC 2.0.
 */
async function topDownActions(socket, skillManager, memoryStream,
                              PERSONALITY, RETRIEVE_IS_BOTH,
                              SKILL_ROOT_PATH,
                              TIMEOUT) {

    // 1. ACQUISIZIONE STATO PRECEDENTE
    const previousStatus = await getStatus(socket)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Error when fetching status: ${error}`);
            return null;
        });

    if (!previousStatus) return null;

    sendMessage(socket, `${BOT_LOG_MSG} Status acquisito (Environment gestito dal client).`);

    // --- AVVIO CRONOMETRO LATENZA ---
    const startTime = performance.now();

    // 2. IL MEGA-PROMPT (Generazione Azione Strategica)
    const megaPlan = await plan(
        socket, memoryStream, previousStatus, PERSONALITY,
        topLocalBadPlans,
        lastTopTaskDone, lastTopFeedbackRcvd,
        RETRIEVE_IS_BOTH, "topDown"
    );

    // --- STOP CRONOMETRO LATENZA ---
    const endTime = performance.now();

    if (!megaPlan || !megaPlan.nextAction) {
        const waitTime = 40000;
        sendMessage(socket, `${BOT_ERR_MSG} Top-Down Plan fallito o API occupata. Pausa di ${waitTime/1000}s...`);
        await sleep(waitTime);
        return null;
    }

    // --- SALVATAGGIO METRICHE NEL CSV ---
    const turnLatency = (endTime - startTime) / 1000; // Converte in secondi
    logTurn(turnLatency, "TopDown");
    // ------------------------------------

    const myPlan = megaPlan.nextAction;
    const memoryUpdate = megaPlan.memoryUpdate;

    // 3. AGGIORNAMENTO MEMORIA (Allineamento Causale)
    if (lastTopTaskDone && memoryUpdate && lastTopStatusRcvd) {
        const isError = lastTopFeedbackRcvd && (lastTopFeedbackRcvd.includes("Error") || lastTopFeedbackRcvd.includes("no path"));
        const memoryType = isError ? "error" : "event";
        const errMsg = isError ? lastTopFeedbackRcvd : "";
        const mapStatusString = JSON.stringify(lastTopStatusRcvd);

        await memoryStream.addMemory(
            memoryType, memoryUpdate.success, Date.now(), 0, Date.now(),
            lastTopTaskDone,
            lastTopActionDone, // Azione del turno precedente
            lastTopTileDone,   // Tile del turno precedente
            lastTopItem1Done,  // Item 1 del turno precedente
            lastTopItem2Done,  // Item 2 del turno precedente
            mapStatusString, memoryUpdate.reasoning,
            "", "", "", "", memoryUpdate.critique || "", errMsg
        );
        sendMessage(socket, `${BOT_LOG_MSG} Memoria salvata per: ${lastTopTaskDone}`);
    }

    // 4. ESECUZIONE DELL'AZIONE ATOMICA
    const feedback = await actAndFeedback(socket, myPlan)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Errore durante l'azione: ${error}`);
            return { logs: "", errors: "Action execution failed" };
        });

    sendMessage(socket, `${BOT_LOG_MSG} Feedback ricevuto dal server.`);

    // 5. PREPARAZIONE PER IL PROSSIMO TURNO STRATEGICO
    lastTopTaskDone = myPlan.task;
    lastTopActionDone = myPlan.action || "";
    lastTopTileDone = JSON.stringify(myPlan.tile || []);
    lastTopItem1Done = myPlan.item1 || "null";
    lastTopItem2Done = myPlan.item2 || "null";

    lastTopFeedbackRcvd = (feedback.errors && feedback.errors !== "") ? feedback.errors : feedback.logs;
    lastTopStatusRcvd = previousStatus;

    // --- SALVATAGGIO DEI BAD PLANS ---
    if (feedback.errors && feedback.errors !== "") {
        topLocalBadPlans.push({
            badPlanSummary: () => `Task: '${myPlan.task}' failed because: ${feedback.errors}`
        });

        if (topLocalBadPlans.length > 3) {
            topLocalBadPlans.shift();
        }
    } else {
        topLocalBadPlans = [];
    }

    // --- GESTIONE DINAMICA DEL RITMO ---
    let finalSleep = 6000;

    if (lastTopFeedbackRcvd.includes("429") || lastTopFeedbackRcvd.includes("Quota")) {
        finalSleep = 45000;
        sendMessage(socket, `${BOT_LOG_MSG} [RATE LIMIT] Cooldown strategico attivato.`);
    }

    sendMessage(socket, `${BOT_LOG_MSG} Turno completato. Attesa: ${finalSleep/1000}s`);
    await sleep(finalSleep);

    return megaPlan;
}

module.exports = {
    topDownActions,
};