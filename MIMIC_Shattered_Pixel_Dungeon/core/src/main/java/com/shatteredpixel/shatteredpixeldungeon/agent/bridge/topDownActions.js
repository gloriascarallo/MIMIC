// [AGGIORNATO - MIMIC 2.0 Resilience Edition]
// Gestione strategica ottimizzata con filtri di sicurezza e protezione Rate Limit.

const { plan } = require("../bot_action/plan");
const { getStatus, actAndFeedback } = require("./client");
const { sendMessage } = require("./sendMessage");

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
        .catch(error => {
            sendMessage(socket, `${BOT_ERR_MSG} Error when fetching status: ${error}`);
            return null;
        });

    if (!previousStatus) return null;

    // --- FILTRO ULTRA-RESILIENTE (Sostituisci il vecchio blocco environment.filter) ---
    if (currentStatus.environment && Array.isArray(currentStatus.environment)) {
        const heroPos = currentStatus["hero position in xy"];

        // Controllo di sicurezza: l'eroe ha una posizione valida?
        if (heroPos && Array.isArray(heroPos) && heroPos.length >= 2) {
            currentStatus.environment = currentStatus.environment.filter(item => {
                try {
                    // Estraiamo tutti i valori dell'oggetto (es: [ [14, 13] ])
                    const values = Object.values(item);
                    if (values.length === 0) return false;

                    // Cerchiamo attivamente l'array che contiene le coordinate [x, y]
                    const coords = values.find(v => Array.isArray(v) && v.length >= 2);

                    if (coords) {
                        const dx = Math.abs(coords[0] - heroPos[0]);
                        const dy = Math.abs(coords[1] - heroPos[1]);
                        // Teniamo solo i tile nel raggio di 8 per alleggerire il prompt
                        return dx <= 8 && dy <= 8;
                    }
                } catch (e) {
                    return false; // Se il tile è strano, lo scartiamo e non crashiamo
                }
                return false;
            });
        }
    }

    sendMessage(socket, `${BOT_LOG_MSG} Status acquisito (Environment ottimizzato).`);

    // 2. IL MEGA-PROMPT (Generazione Azione Strategica)
    const megaPlan = await plan(
        socket, memoryStream, previousStatus, PERSONALITY,
        [],
        lastTopTaskDone, lastTopFeedbackRcvd,
        RETRIEVE_IS_BOTH, "topDown"
    );

    // Gestione Errore API o Quota Exceeded (429)
    if (!megaPlan || !megaPlan.nextAction) {
        const waitTime = 40000; // 40 secondi di cooldown se l'API è sovraccarica
        sendMessage(socket, `${BOT_ERR_MSG} Top-Down Plan fallito o API occupata. Pausa di ${waitTime/1000}s...`);
        await sleep(waitTime);
        return null;
    }

    const myPlan = megaPlan.nextAction;
    const memoryUpdate = megaPlan.memoryUpdate;

    // 3. AGGIORNAMENTO MEMORIA
    if (lastTopTaskDone && memoryUpdate && lastTopStatusRcvd) {
        const isError = lastTopFeedbackRcvd && (lastTopFeedbackRcvd.includes("Error") || lastTopFeedbackRcvd.includes("no path"));
        const memoryType = isError ? "error" : "event";
        const errMsg = isError ? lastTopFeedbackRcvd : "";
        const mapStatusString = JSON.stringify(lastTopStatusRcvd);

        await memoryStream.addMemory(
            memoryType, memoryUpdate.success, Date.now(), 0, Date.now(),
            lastTopTaskDone, myPlan.action, JSON.stringify(myPlan.tile),
            myPlan.item1 || "null", myPlan.item2 || "null",
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
    lastTopFeedbackRcvd = (feedback.errors && feedback.errors !== "") ? feedback.errors : feedback.logs;
    lastTopStatusRcvd = previousStatus;

    // --- GESTIONE DINAMICA DEL RITMO (RATE LIMIT PROTECTION) ---
    let finalSleep = 6000; // 6 secondi base per non saturare il Free Tier

    if (lastTopFeedbackRcvd.includes("429") || lastTopFeedbackRcvd.includes("Quota")) {
        finalSleep = 45000; // Se rileviamo un limite raggiunto, cooldown lungo
        sendMessage(socket, `${BOT_LOG_MSG} [RATE LIMIT] Cooldown strategico attivato.`);
    }

    sendMessage(socket, `${BOT_LOG_MSG} Turno completato. Attesa: ${finalSleep/1000}s`);
    await sleep(finalSleep);

    return [myPlan];
}

module.exports = {
    topDownActions,
};