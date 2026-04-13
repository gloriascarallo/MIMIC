// [AGGIORNATO - MIMIC 2.0]
// Rimosse dipendenze da summarize, planDecide e planDecompose.

const {plan} = require("../bot_action/plan");
const {getStatus, actAndFeedback} = require("./client");
const {sendMessage} = require("./sendMessage");

const BOT_LOG_MSG = "bridge.bottomUpActions:log";
const BOT_ERR_MSG ="bridge.bottomUpActions:error";

// Funzione per mettere in pausa il bot per stabilità API e sincronizzazione server
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- VARIABILI GLOBALI PER LA MEMORIA A BREVE TERMINE ---
let lastTaskDone = null;
let lastFeedbackRcvd = null;
let lastStatusRcvd = null;

/**
 * Esegue le azioni bottom-up del bot usando l'architettura MIMIC 2.0.
 * Valuta il turno precedente e pianifica il prossimo in un'unica chiamata.
 */
async function bottomUpActions(socket, skillManager, memoryStream,
                               PERSONALITY, RETRIEVE_IS_BOTH,
                               TIMEOUT) {

    // 1. RECUPERO DELLO STATO CORRENTE
    const currentStatus = await getStatus(socket)
        .then(response => response)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Errore nel fetching status: ${error}`);
            return null;
        });

    if (!currentStatus) return null;

    sendMessage(socket, `${BOT_LOG_MSG} Stato corrente acquisito.`);

    // 2. IL MEGA-PROMPT (Architettura Single-Shot)
    // Passiamo il risultato del turno precedente direttamente a Gemini.
    // Non serve più il ciclo while perché l'IA si autocorregge leggendo lastFeedbackRcvd.
    const megaPlan = await plan(
        socket, memoryStream, currentStatus, PERSONALITY,
        [], // latestBadPlans svuotato: la memoria ora è gestita tramite feedback
        lastTaskDone, lastFeedbackRcvd,
        RETRIEVE_IS_BOTH, "bottomUp"
    );

    if (!megaPlan || !megaPlan.nextAction) {
        sendMessage(socket, `${BOT_ERR_MSG} Il Piano generato è NULL o non valido.`);
        return null;
    }

    const nextAction = megaPlan.nextAction;
    const memoryUpdate = megaPlan.memoryUpdate;

    // 3. AGGIORNAMENTO MEMORIA SOGGETTIVA E VETTORIALE
    // Analizziamo cosa è successo nel turno precedente prima di procedere.
    if (lastTaskDone && memoryUpdate && lastStatusRcvd) {

        const isError = lastFeedbackRcvd && lastFeedbackRcvd.includes("Error");
        const memoryType = isError ? "error" : "event";
        const errMsg = isError ? lastFeedbackRcvd : "";
        const mapStatusString = JSON.stringify(lastStatusRcvd);

        await memoryStream.addMemory(
            memoryType,                         // event o error
            memoryUpdate.success,               // Boolean dal Mega-Prompt
            Date.now(),                         // timeCreated
            0,                                  // timeExpired
            Date.now(),                         // lastAccessed
            lastTaskDone,                       // Il task appena concluso
            nextAction.action,                  // L'azione tecnica scelta
            JSON.stringify(nextAction.tile),    // Il tile target
            nextAction.item1 || "null",
            nextAction.item2 || "null",
            mapStatusString,                    // Stato precedente (cruciale per Embedding)
            memoryUpdate.reasoning,             // Ragionamento soggettivo del bot
            "",                                 // decideReason (deprecato)
            "",                                 // summarizeReason (deprecato)
            "",                                 // code (deprecato)
            "",                                 // skills
            memoryUpdate.critique || "",        // Critica costruttiva se ha fallito
            errMsg                              // Messaggio di errore tecnico
        );

        sendMessage(socket, `${BOT_LOG_MSG} Memoria salvata correttamente per: ${lastTaskDone}`);
    }

    // 4. ESECUZIONE DELL'AZIONE SUL SERVER DI GIOCO
    const feedback = await actAndFeedback(socket, nextAction)
        .then(response => response)
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Errore durante l'azione: ${error}`);
            return { logs: "", errors: "Errore di connessione durante l'azione" };
        });

    sendMessage(socket, `${BOT_LOG_MSG} Feedback ricevuto: ${JSON.stringify(feedback)}`);

    // 5. SALVATAGGIO STATO PER IL PROSSIMO TURNO
    // Queste variabili verranno passate al Mega-Prompt nel prossimo ciclo.
    lastTaskDone = nextAction.task;
    lastFeedbackRcvd = (feedback.errors && feedback.errors !== "") ? feedback.errors : feedback.logs;
    lastStatusRcvd = currentStatus;

    // Pausa di sicurezza: evita il flooding del server e rispetta i rate limit di Gemini
    await sleep(2000);

    return nextAction;
}

module.exports = {
    bottomUpActions,
};