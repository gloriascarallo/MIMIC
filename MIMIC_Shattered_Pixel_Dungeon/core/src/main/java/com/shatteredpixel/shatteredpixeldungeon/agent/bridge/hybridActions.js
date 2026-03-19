const {bottomUpActions} = require("./bottomUpActions");
const {topDownActions} = require("./topDownActions");


/**
 * Do the hybrid actions for the bot
 */
async function hybridActions(socket, skillManager, memoryStream,
                             PERSONALITY,
                             RETRIEVE_IS_BOTH, SKILL_ROOT_PATH,
                             TIMEOUT,
                             cnt, isBottomUp = true,
                             switchCondition="S", thresholdD=20, thresholdS=30) {

    let changed = false;

    // Switch to top down if having enough skills
    if (isBottomUp && (switchCondition === "S" || switchCondition === "H") &&
        (memoryStream.memoryCount >= thresholdS && memoryStream.memoryCount < thresholdS + 10)) {
        isBottomUp = false;
        changed = true;
    }

    if (isBottomUp) {

        let newTask = await bottomUpActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, TIMEOUT);

        cnt += 1;
        // if task is new, reset the counter
        if (!memoryStream.hasTask(newTask)) {
            cnt = 0;
        }

    } else {
        // topDownActions ha già i suoi sleep interni ora, quindi qui non serve aggiungerne altri
        let subTasks = await topDownActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, SKILL_ROOT_PATH, TIMEOUT);

        for (const subTask of subTasks) {
            cnt += 1;
            // if task is new, reset the counter
            if (!memoryStream.hasTask(subTask)) {
                cnt = 0;
            }
        }
    }

    // if the repeated task appears for larger than thresholdD, switch
    if (!changed && (switchCondition === "D" || switchCondition === "H") && (cnt >= thresholdD)) {
        isBottomUp = !isBottomUp;
    }

    return {
        isBottomUp: isBottomUp,
        cnt: cnt,
    };
}

module.exports = {
    hybridActions,
};