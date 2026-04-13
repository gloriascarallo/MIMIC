// [AGGIORNATO - MIMIC 2.0 Resilience Edition]
// Gestione ottimizzata dell'environment e dei tempi di attesa per Gemini Free Tier.

const { plan } = require("../bot_action/plan");
const { getStatus, actAndFeedback } = require("./client");
const { sendMessage } = require("./sendMessage");

const BOT_LOG_MSG = "bridge.bottomUpActions:log";
const BOT_ERR_MSG = "bridge.bottomUpActions:error";

// Funzione per mettere in pausa il bot (stabilità API e sincronizzazione)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Variabili globali per la continuità turn-by-turn
let lastTaskDone = null;
let lastFeedbackRcvd = null;
let lastStatusRcvd = null;

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

    // --- FILTRO ULTRA-RESILIENTE  ---
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

    sendMessage(socket, `${BOT_LOG_MSG} Stato acquisito (Environment ottimizzato a raggio 8).`);

    // 2. CHIAMATA AL MEGA-PROMPT (Architettura Single-Shot)
    const megaPlan = await plan(
        socket, memoryStream, currentStatus, PERSONALITY,
        [], // Bad plans svuotati: gestiti dal feedback turn-by-turn
        lastTaskDone, lastFeedbackRcvd,
        RETRIEVE_IS_BOTH, "bottomUp"
    );

    // Se l'API restituisce un errore (Quota Exceeded 429 o Service Unavailable 503)
    if (!megaPlan || !megaPlan.nextAction) {
        const cooldown = 40000; // 40 secondi di attesa forzata
        sendMessage(socket, `${BOT_ERR_MSG} API Busy o Quota esaurita. Pausa di ${cooldown/1000}s...`);
        await sleep(cooldown);
        return null;
    }

    const nextAction = megaPlan.nextAction;
    const memoryUpdate = megaPlan.memoryUpdate;

    // 3. AGGIORNAMENTO MEMORIA SOGGETTIVA
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
            nextAction.action,
            JSON.stringify(nextAction.tile),
            nextAction.item1 || "null",
            nextAction.item2 || "null",
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

    // 5. PREPARAZIONE PER IL TURNO SUCCESSIVO
    lastTaskDone = nextAction.task;
    lastFeedbackRcvd = (feedback.errors && feedback.errors !== "") ? feedback.errors : feedback.logs;
    lastStatusRcvd = currentStatus;

    // --- GESTIONE DINAMICA DEL RITMO (PROTEZIONE QUOTA) ---
    let finalSleep = 6000; // Default 6 secondi (ideale per 10-15 RPM)

    if (lastFeedbackRcvd.includes("429") || lastFeedbackRcvd.includes("Quota")) {
        finalSleep = 45000; // Se rileviamo un limite raggiunto, ci fermiamo per 45s
        sendMessage(socket, `${BOT_LOG_MSG} [RATE LIMIT] Cooldown lungo attivato.`);
    }

    sendMessage(socket, `${BOT_LOG_MSG} Turno finito. Attesa: ${finalSleep/1000}s`);
    await sleep(finalSleep);

    return nextAction;
}

module.exports = {
    bottomUpActions,
};