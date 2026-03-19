// Imports for actions
const {plan} = require("../bot_action/plan");
const {planDecide} = require("../bot_action/planDecide");
const {summarize} = require("../bot_action/summarize");
const {getStatus, actAndFeedback} = require("./client");
const {sendMessage} = require("./sendMessage");

const BOT_LOG_MSG = "bridge.bottomUpActions:log";
const BOT_ERR_MSG ="bridge.bottomUpActions:error";

// Funzione per mettere in pausa il bot
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Do the bottom-up actions for the bot
 */
async function bottomUpActions(socket, skillManager, memoryStream,
                               PERSONALITY, RETRIEVE_IS_BOTH,
                               TIMEOUT) {

    memoryStream.clearLatestBadPlans(); // Clear bad plans before new run

    const previousStatus = await getStatus(socket)
        .then(function(response) {
            return response;
        })
        .catch(function(error) {
            sendMessage(socket, `${BOT_ERR_MSG} Error when fetching status: ${error}`);
        });

    sendMessage(socket, `${BOT_LOG_MSG} Previous Status: ${JSON.stringify(previousStatus)}`);

    let planDecision = false;
    let myPlan;

    while (!planDecision){
        // Il rate limiter in open_ai.js gestirà automaticamente l'attesa per queste chiamate!
        myPlan = await plan(socket, memoryStream, previousStatus, PERSONALITY, memoryStream.latestBadPlans, RETRIEVE_IS_BOTH, "bottomUp");

        if (myPlan === null) {
            sendMessage(socket, `${BOT_ERR_MSG} Plan is NULL.`);
            continue;
        }

        planDecision = await planDecide(socket, memoryStream, previousStatus, PERSONALITY, myPlan);
        if (planDecision === null) {
            sendMessage(socket, `${BOT_ERR_MSG} planDecision is NULL.`);
            planDecision = false;
        }
    }

    // Send the action plan
    const feedback = await actAndFeedback(socket, myPlan)
        .then(function(response) {
            return response;
        })
        .catch(function(error) {
            sendMessage(socket, `${BOT_ERR_MSG} Error when acting: ${error}`);
        });

    sendMessage(socket, `${BOT_LOG_MSG} Feedback received from server: ${JSON.stringify(feedback)}`);

    // Handle the feedback
    let bot_msg = feedback.logs;
    let err_msg = feedback.errors;
    let memoryType = feedback.errors === "" ? "event" : "error";

    // --- RISOLUZIONE DEL FIXME ---
    // Aspettiamo 2 secondi PRIMA di chiedere al server il nuovo stato,
    // in modo che il gioco abbia il tempo di ricalcolare i danni e l'inventario!
    await sleep(2000);

    const newStatus = await getStatus(socket)
        .then(function(response) {
            return response;
        })
        .catch(function(error) {
            sendMessage(socket, `${BOT_ERR_MSG} Error when fetching status: ${error}`);
        });

    // Summarize the action
    let newMemory = await summarize(socket, "", memoryStream, memoryType,
        previousStatus, newStatus,
        myPlan, "", "", "", bot_msg, err_msg, false);

    sendMessage(socket, `${BOT_LOG_MSG} newMemory: ${JSON.stringify(newMemory)}`);

    return myPlan;
}

module.exports = {
    bottomUpActions,
};