// [DEPRECATO]
// Questo modulo (DEPRECATED_expect.js) è obsoleto.
// Le aspettative sulle conseguenze delle azioni sono ora parte del processo
// decisionale integrato in plan.js.

const fs = require("fs");
const callOpenAI = require("../bridge/open_ai");

const BOT_LOG_MSG = "bot_action.DEPRECATED_expect:log";

/**
 *
 * @param socket
 * @param task The current task from the Planner
 * @returns {Promise<{item: (string|*), quantity: (number|*), reasoning: (string|*)}>}
 */
async function DEPRECATED_expect(socket, task) {

    let context = fs.readFileSync("./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/DEPRECATED_expect_prompt.txt", 'utf8');

    let expectation = await callOpenAI(socket, context, "Task: " + task, BOT_LOG_MSG, "gpt-4o", false, true);

    if (!expectation) {
        console.log(BOT_LOG_MSG, "OpenAI response was empty. Ignore.");
        return null;
    }

    let myExpectation = JSON.parse(expectation);

    return{
        reasoning: myExpectation.reasoning,
        change: myExpectation.change
    }
}

module.exports = {
    expect: DEPRECATED_expect,
};