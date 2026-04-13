// [AGGIORNATO - MIMIC 2.0]
// Questo modulo gestisce lo switch tra pianificazione reattiva (Bottom-Up)
// e strategica (Top-Down). Ottimizzato per gestire gli oggetti azione invece delle stringhe.

const {bottomUpActions} = require("./bottomUpActions");
const {topDownActions} = require("./topDownActions");

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

    // 1. LOGICA DI SWITCH BASATA SULL'ESPERIENZA (S)
    // Se abbiamo accumulato abbastanza memoria, passiamo alla modalità strategica
    if (isBottomUp && (switchCondition === "S" || switchCondition === "H") &&
        (memoryStream.memoryCount >= thresholdS && memoryStream.memoryCount < thresholdS + 10)) {
        isBottomUp = false;
        changed = true;
    }

    // 2. ESECUZIONE AZIONE
    if (isBottomUp) {
        // Esegue una singola azione reattiva
        let newActionObj = await bottomUpActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, TIMEOUT);

        if (newActionObj && newActionObj.task) {
            // Se il task è nuovo, resettiamo il contatore di ripetizione
            if (!memoryStream.hasTask(newActionObj.task)) {
                cnt = 0;
            } else {
                cnt += 1;
            }
        }

    } else {
        // Esegue l'azione strategica (ora restituisce un array di una singola azione in MIMIC 2.0)
        let subTasks = await topDownActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, SKILL_ROOT_PATH, TIMEOUT);

        if (subTasks && subTasks.length > 0) {
            for (const subTask of subTasks) {
                // Gestiamo l'oggetto azione restituito dal nuovo topDownActions
                let taskString = typeof subTask === 'string' ? subTask : (subTask.task || "");

                if (taskString) {
                    if (!memoryStream.hasTask(taskString)) {
                        cnt = 0;
                    } else {
                        cnt += 1;
                    }
                }
            }
        }
    }

    // 3. LOGICA DI SWITCH BASATA SULLA STASI (D)
    // Se il bot ripete lo stesso task troppo a lungo (es. incastrato), cambia modalità
    if (!changed && (switchCondition === "D" || switchCondition === "H") && (cnt >= thresholdD)) {
        isBottomUp = !isBottomUp;
        cnt = 0; // Resettiamo dopo lo switch per evitare loop di cambiamento
    }

    return {
        isBottomUp: isBottomUp,
        cnt: cnt,
    };
}

module.exports = {
    hybridActions,
};