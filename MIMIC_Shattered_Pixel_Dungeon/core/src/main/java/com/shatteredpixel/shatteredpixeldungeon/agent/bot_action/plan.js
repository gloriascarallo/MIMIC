const fs = require("fs");
const callOpenAI = require("../bridge/open_ai");
const {status2Prompt} = require("../bridge/client");
const {sendMessage} = require("../bridge/sendMessage");
const {MemoryStream} = require("../memory_system/memoryStream");

const BOT_LOG_MSG = "bot_action.plan:log";

/**
 * Transfer the given status into the wanted format for the planner
 * @param {MemoryStream} memoryStream
 * @param {JSON} status
 * @param {{}} latestBadPlans
 * @param {boolean} isBoth
 * @returns {string}
 */
async function statusToPlanInput(memoryStream, status, latestBadPlans, isBoth) {
    let newStatus = status2Prompt(status);
    let badPlans = "";
    let relatedTasks = "";
    let preferredTasks = "";

    for (let bp in latestBadPlans) {
        badPlans += JSON.stringify(latestBadPlans[bp].badPlanSummary()) + "\n";
    }

    // 1. Assicuriamoci che newStatus sia una vera stringa e puliamola dagli spazi vuoti
    let memoryQuery = newStatus ? String(newStatus).trim() : "";

    // 2. Paracadute di sicurezza per la lunghezza (tagliamo a 1000 per massima sicurezza)
    if (memoryQuery.length > 1000) {
        memoryQuery = memoryQuery.substring(0, 1000);
    }

    // 3. Fallback se il testo è vuoto o troppo corto, altrimenti forziamo delle parole vere
    if (memoryQuery.length < 5 || memoryQuery === "{}") {
        memoryQuery = "initial safe environment, no entities or special events";
    } else {
        // Il prefisso in inglese garantisce sempre dei token validi
        memoryQuery = "Current game state: " + memoryQuery;
    }

    // 4. STAMPA DI DEBUG: così vediamo nel terminale cosa stiamo inviando!
    console.log("\n>>> [DEBUG] Testo inviato all'IA per la memoria:", memoryQuery, "\n");

    // 5. Interroghiamo la memoria in modo sicuro
    let relatedMemories = await memoryStream.retrieveMemories(memoryQuery, isBoth);

    let pastRecentTasks = await memoryStream.retrievePastRecentMemories();

    // If it is only returning memories based on Utility
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

    // If it is returning memories based on Relevance and Preference separately
    for (let id of relatedMemories.R) {

        if (memoryStream.memories[id]) {
            relatedTasks += JSON.stringify(memoryStream.memories[id].planSummary()) + "\n";
        }
    }
    for (let id of relatedMemories.P) {
        if (memoryStream.memories[id]) {
            preferredTasks += JSON.stringify(memoryStream.memories[id].planSummary()) + "\n";
        }
    }

    newStatus += "Related tasks did before: " + relatedTasks +'\n';
    newStatus += "Past Recent tasks: " + pastRecentTasks +'\n';
    newStatus += "Preferred tasks by the personality you have: " + preferredTasks +'\n';
    newStatus += "Past rejected tasks: " + badPlans;

    return newStatus;
}

/**
 * Do the plan for the next task
 * @param socket The WebSocket connection
 * @param memoryStream The memory stream
 * @param status The current status of SPD
 * @param personality The pre-defined personality for the agent to act
 * @param latestBadPlans The latest bad plans to be avoided
 * @param {boolean} retrieveMethod If True, retrieve top 5 of each measure (R & P); Otherwise, retrieve top 10 of measure U (= αR + βP)
 * @param prefix The prefix of the plan prompt
 * @returns {Promise<{reasoning: string, task: string, tile: number[]|string, item1: string, item2: string}>}
 */
async function plan(socket, memoryStream, status, personality, latestBadPlans, retrieveMethod=false, prefix="bottomUp") {
    const persaContext = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/personalities/${personality}.txt`, 'utf8');
    const persaExampleContext = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/personalities/${personality}_examples.txt`, 'utf8');

    let context;

    if (retrieveMethod)
        context = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/${prefix}_plan_prompt_RP.txt`, 'utf8');
    else
        context = fs.readFileSync(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/${prefix}_plan_prompt_U.txt`, 'utf8');

    context = context.replace("{Personalities}", persaContext);
    context = context.replace("{Personalities_Examples}", persaExampleContext);

    let currStatus = await statusToPlanInput(memoryStream, status, latestBadPlans, retrieveMethod);

    let newPlan = await callOpenAI(socket, context, currStatus, BOT_LOG_MSG, "gemini-2.5-flash", false, true);

    if (!newPlan) {
        sendMessage(socket, `${BOT_LOG_MSG} OpenAI response was empty. Ignore.`);
        return null;
    }

    newPlan = newPlan.slice(newPlan.indexOf('{'), newPlan.indexOf('}') + 1);

    let myPlan = JSON.parse(newPlan);

    return {
        reasoning: myPlan.reasoning,
        task: myPlan.task,
        action: myPlan.action,
        tile: myPlan.tile,
        item1: myPlan.item1,
        item2: myPlan.item2,
        waitTurns: myPlan.waitTurns,
    }
}

module.exports = {
    plan,
};