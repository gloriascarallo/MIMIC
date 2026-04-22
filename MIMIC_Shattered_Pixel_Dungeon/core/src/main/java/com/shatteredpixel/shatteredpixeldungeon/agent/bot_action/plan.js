const fs = require("fs");
const callOpenAI = require("../bridge/open_ai");
const {status2Prompt} = require("../bridge/client");
const {sendMessage} = require("../bridge/sendMessage");

const BOT_LOG_MSG = "bot_action.plan:log";

/**
 * Funzione di utilità per caricare le riflessioni strategiche (Evoluzione tramite Memoria)
 */
function getStrategicLessons() {
    const path = `./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/lessons_learned.txt`;

    try {
        // 1. Prima controlliamo se NON esiste per crearlo
        if (!fs.existsSync(path)) {
            fs.writeFileSync(path, "", "utf8");
            return null;
        }

        // 2. Se esiste, leggiamo
        const content = fs.readFileSync(path, 'utf8');
        return content.trim().length > 0 ? content : null;

    } catch (err) {
        console.error("Errore durante la lettura delle lezioni strategiche:", err);
        return null;
    }
}

async function statusToPlanInput(memoryStream, status, latestBadPlans, isBoth) {
    let newStatus = status2Prompt(status);
    let badPlans = "";
    let relatedTasks = "";
    let preferredTasks = "";

    for (let bp in latestBadPlans) {
        badPlans += JSON.stringify(latestBadPlans[bp].badPlanSummary()) + "\n";
    }

    let memoryQuery = newStatus ? String(newStatus).trim() : "";
    if (memoryQuery.length > 1000) memoryQuery = memoryQuery.substring(0, 1000);

    if (memoryQuery.length < 5 || memoryQuery === "{}") {
        memoryQuery = "initial safe environment, no entities or special events";
    } else {
        memoryQuery = "Current game state: " + memoryQuery;
    }

    // Recupero memorie correlate e preferite (RAG) [cite: 178, 182]
    let relatedMemories = await memoryStream.retrieveMemories(memoryQuery, isBoth);
    let pastRecentTasks = await memoryStream.retrievePastRecentMemories();

    if (!isBoth) {
        for (let id of relatedMemories) {
            if (memoryStream.memories[id]) {
                relatedTasks += JSON.stringify(memoryStream.memories[id].planSummary()) + "\n";
            }
        }
        newStatus += "Related tasks did before: " + relatedTasks +'\n';
        newStatus += "Past Recent tasks: " + pastRecentTasks +'\n';
        newStatus += "Past rejected tasks: " + badPlans;
        return newStatus;
    }

    for (let id of relatedMemories.R) {
        if (memoryStream.memories[id]) relatedTasks += JSON.stringify(memoryStream.memories[id].planSummary()) + "\n";
    }
    for (let id of relatedMemories.P) {
        if (memoryStream.memories[id]) preferredTasks += JSON.stringify(memoryStream.memories[id].planSummary()) + "\n";
    }

    newStatus += "Related tasks did before: " + relatedTasks +'\n';
    newStatus += "Past Recent tasks: " + pastRecentTasks +'\n';
    newStatus += "Preferred tasks by the personality you have: " + preferredTasks +'\n';
    newStatus += "Past rejected tasks: " + badPlans;

    return newStatus;
}

async function plan(socket, memoryStream, status, personality, latestBadPlans, lastTask = null, lastFeedback = null, retrieveMethod=false, prefix="bottomUp") {

    // --- Profili Adattivi (Switch di Personalità) ---
    let adaptivePersonality = personality;

    // Verifichiamo che i dati esistano e calcoliamo il rapporto di salute
    if (status && status.health !== undefined && status.maxHealth !== undefined) {
        const healthRatio = status.health / status.maxHealth;

        // Se la salute è sotto il 25%, l'agente adotta una strategia di Cautela [cite: 46, 170]
        if (healthRatio < 0.25) {
            adaptivePersonality = "caution";
            console.log(`[ADAPTIVE] Salute critica: ${status.health}/${status.maxHealth}. Switch a: ${adaptivePersonality}`);
        }
    }

    const persaContext = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/personalities/${adaptivePersonality}.txt`, 'utf8');
    const persaExampleContext = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/personalities/${adaptivePersonality}_examples.txt`, 'utf8');

    let context;
    if (retrieveMethod)
        context = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/${prefix}_plan_prompt_RP.txt`, 'utf8');
    else
        context = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/${prefix}_plan_prompt_U.txt`, 'utf8');

    context = context.replace("{Personalities}", persaContext);
    context = context.replace("{Personalities_Examples}", persaExampleContext);

    let currStatus = await statusToPlanInput(memoryStream, status, latestBadPlans, retrieveMethod);

    // --- Iniezione "Lezioni Apprese" (Evoluzione Strategica) ---
    const strategicLessons = getStrategicLessons();
    if (strategicLessons) {
        currStatus += `\n\nSTRATEGIC ADAPTATIONS (Reflections from past experiences):\n${strategicLessons}`;
    }

    if (lastTask && lastFeedback) {
        currStatus += `\n\nPREVIOUS TURN RESULT:\nAttempted Task: ${lastTask}\nGame Feedback: ${lastFeedback}\nEvaluate this result in the 'memory_update' section of your JSON.`;
    } else {
        currStatus += `\n\nPREVIOUS TURN RESULT: None (First turn). Set 'memory_update' success to true, critique to 'null', and write a generic subjective analysis.`;
    }

    currStatus += "\n\nCRITICAL SURVIVAL RULE: You ARE the 'guerriero' (the hero). Do NOT attack 'guerriero' and do NOT target the tile you are currently standing on.\n";

    let newPlan = await callOpenAI(socket, context, currStatus, BOT_LOG_MSG, "gpt-4o", false, true);

    if (!newPlan) {
        sendMessage(socket, `${BOT_LOG_MSG} OpenAI response was empty. Ignore.`);
        return null;
    }

    const firstBracket = newPlan.indexOf('{');
    const lastBracket = newPlan.lastIndexOf('}');
    if (firstBracket !== -1 && lastBracket !== -1) {
        newPlan = newPlan.substring(firstBracket, lastBracket + 1);
    }

    let myPlan;
    try {
        myPlan = JSON.parse(newPlan);
    } catch (e) {
        console.error(`${BOT_LOG_MSG} Impossibile parsare il piano:`, newPlan);
        return null;
    }

    return {
        memoryUpdate: myPlan.memory_update || null,
        nextAction: myPlan.next_action || myPlan
    };
}

module.exports = { plan };