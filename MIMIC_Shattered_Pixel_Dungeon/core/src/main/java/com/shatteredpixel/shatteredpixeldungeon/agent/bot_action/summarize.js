const fs = require("fs");
const callOpenAI = require("../bridge/open_ai");

/**
 * MIMIC STRATEGIC REFLECTOR
 * Questo modulo analizza cicli di memorie per generare adattamenti strategici.
 * * @param {Object} socket - Il bridge di comunicazione con il gioco.
 * @param socket
 * @param {Array} recentMemories - Array di oggetti contenenti l'esito dei turni (success, task, analysis, critique).
 * @param {string} currentPersonality - La personalità attuale dell'agente (es. "Aggressive", "Caution").
 * @returns {Promise<string|null>} - La riflessione generata o null in caso di errore.
 */
async function performPeriodicReflection(socket, recentMemories, currentPersonality) {

    // 1. Configurazione del Context per il Supervisore (Action Summarizer avanzato)
    // Utilizziamo la tecnica Chain-of-Thought (CoT) per motivare le lezioni generate[cite: 159].
    const context = `Sei un supervisore AI per il gioco Shattered Pixel Dungeon. 
    Il tuo compito è analizzare le prestazioni di un agente con personalità: ${currentPersonality}.
    Analizza i turni forniti e identifica se i fallimenti sono dovuti a limiti intrinseci della personalità o a errori tattici ricorrenti.
    Genera ESATTAMENTE 3 lezioni brevi, numerate e attuabili per migliorare la sopravvivenza nei prossimi turni.
    Le tue lezioni verranno inserite direttamente nel Planner per guidare le decisioni future[cite: 127, 160].`;

    // 2. Trasformazione delle memorie recenti in stringa per l'LLM [cite: 175, 182]
    // Includiamo l'analisi soggettiva e la critica per permettere una riflessione profonda[cite: 155, 180].
    const memoryHistory = recentMemories.map(m =>
        `Turno ${m.turn}: ${m.success ? "SUCCESSO" : "FALLIMENTO"} 
         Task: ${m.task}
         Analisi: ${m.subjective_analysis}
         Critica: ${m.critique || 'nessuna'}`
    ).join("\n---\n");

    // 3. Chiamata all'LLM per la sintesi strategica
    // MIMIC accumula conoscenza nel tempo per risolvere compiti complessi[cite: 47, 603].
    const reflection = await callOpenAI(socket, context, memoryHistory, "bot_reflector:log", "gpt-4o", false, true);

    if (reflection) {
        const path = "./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/lessons_learned.txt";

        try {
            // 4. Salvataggio delle riflessioni (Strategic Adaptations)
            // Usiamo writeFileSync per sovrascrivere: MIMIC suggerisce di gestire i token in modo efficiente[cite: 177, 179].
            // Mantenendo solo le riflessioni più fresche, riduciamo l'overhead e il rischio di allucinazioni[cite: 178, 365].
            fs.writeFileSync(path, reflection, "utf8");

            console.log(`\n>>> [MIMIC REFLECTOR] Nuove lezioni salvate per la personalità ${currentPersonality}.`);
            return reflection;
        } catch (err) {
            console.error("Errore nel salvataggio del file lessons_learned.txt:", err);
            return null;
        }
    }

    return null;
}

module.exports = { performPeriodicReflection };