// Imports for actions
const {plan} = require("../bot_action/plan");
const {planDecide} = require("../bot_action/planDecide");
const {summarize} = require("../bot_action/summarize");
const {getStatus, actAndFeedback} = require("./client");
const {sendMessage} = require("./sendMessage");
const {planDecompose} = require("../bot_action/planDecompose");

const BOT_LOG_MSG = "bridge.topDownActions:log";
const BOT_ERR_MSG ="bridge.topDownActions:error";

// Funzione per mettere in pausa il bot (serve solo per aspettare il server di gioco)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Do the top-down actions for the bot
 */
async function topDownActions(socket, skillManager, memoryStream,
                              PERSONALITY, RETRIEVE_IS_BOTH,
                              SKILL_ROOT_PATH,
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
    let subGoals = null;

    while (!planDecision){
        // open_ai.js gestisce le pause API
        myPlan = await plan(socket, memoryStream, previousStatus, PERSONALITY, memoryStream.latestBadPlans, RETRIEVE_IS_BOTH, "topDown");

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

    let subPlanDecision = true;

    // Create the subGoals until all the goals are accepted
    planDecomposition:
        while (subGoals === null || subGoals.length <= 0 || !subPlanDecision) {

            subGoals = await planDecompose(socket, previousStatus, myPlan);

            if (subGoals === null) {
                sendMessage(socket, `${BOT_ERR_MSG} subGoals is NULL.`);
            }

            // Check each sub plan
            for (const subGoal of subGoals) {

                subPlanDecision = await planDecide(socket, memoryStream, previousStatus, PERSONALITY, subGoal);

                if (subPlanDecision === null) {
                    sendMessage(socket, `${BOT_ERR_MSG} subPlanDecision is NULL.`);
                    subPlanDecision = false;
                }

                // If any of the sub plan is not good, re-plan all
                if (subPlanDecision === false) {
                    continue planDecomposition;
                }
            }
        }

    // For each subGoal, do the same stuff as the bottom up
    for (const subGoal of subGoals) {
        // Send the action plan
        const feedback = await actAndFeedback(socket, subGoal)
            .then(function(response) {
                return response;
            })
            .catch(function(error) {
                sendMessage(socket, `${BOT_ERR_MSG} Error when acting: ${error}`);
            });

        sendMessage(socket, `${BOT_LOG_MSG} Feedback received from server: ${JSON.stringify(feedback)}`);

        let bot_msg = feedback.logs;
        let err_msg = feedback.errors;
        let memoryType = feedback.errors === "" ? "event" : "error";

        // --- RISOLUZIONE DEL PROBLEMA DI SINCRONIZZAZIONE ---
        // Aspettiamo 2 secondi prima di fotografare il nuovo stato per far aggiornare il gioco
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
            subGoal, "", "", "", bot_msg, err_msg, false);

        sendMessage(socket, `${BOT_LOG_MSG} newMemory: ${JSON.stringify(newMemory)}`);
    }

    return subGoals;
}

module.exports = {
    topDownActions,
};