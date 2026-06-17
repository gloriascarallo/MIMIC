require('dotenv').config();
const WebSocket = require('ws');
const config = require('../../../../../../../../../config.json');

// Moduli del sistema MIMIC
const { MemoryStream } = require("../memory_system/MemoryStream");
const { SkillManager } = require("../skill_library/SkillManager");
const { sendMessage } = require("./sendMessage");
const { getStatus, status2Prompt } = require("./client");

// Utility per rallentare il bot
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const { bottomUpActions } = require("./bottomUpActions");
const { topDownActions } = require("./topDownActions");
const { hybridActions } = require("./hybridActions");
const { performPeriodicReflection } = require("../bot_action/summarize");

const BOT_LOG_MSG = "bridge.agentClient:log";

// Configurazione
const PERSONALITY = config.MIMIC_PERSONALITY;
const COLLECTION_NAME = "Run1";
const IS_INHERIT = config.IS_CONTINUE;
const TIMEOUT = 10 * 60000;
const DURATION = 60000 * 60 * 24;

const PLANNER_TYPE = "hybrid";
const PLANNER_SWITCH_COND = "H";
const THRESHOLD_D = 20;
const THRESHOLD_S = 100;
const RETRIEVE_IS_BOTH = true;

let recentTurnsBuffer = [];
let currentTurn = 0;
let isBottomUp = true;
let dCounter = 0;

// Variabili per la memoria spaziale (Scia di briciole)
let visitedTiles = new Set();
let currentDepth = -1;
// ----------------------------------------------------------------------

const SKILL_ROOT_PATH = `./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/skill_library/skill_${COLLECTION_NAME}/`;
const MEMORY_ROOT_PATH = `./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/memory_system/${COLLECTION_NAME}/`;

// TENTATIVO DI CONNESSIONE
const socket = new WebSocket(`ws://localhost:${config.PORT}`);

const skillManager = new SkillManager(socket, SKILL_ROOT_PATH, COLLECTION_NAME, PERSONALITY, IS_INHERIT);
const memoryStream = new MemoryStream(socket, MEMORY_ROOT_PATH, COLLECTION_NAME, PERSONALITY, IS_INHERIT);

let startTime;

socket.onopen = function() {
    console.log(`${BOT_LOG_MSG} Connesso!`);
    sendMessage(socket, `${BOT_LOG_MSG} Agente connesso al server WebSocket.`);
    startTime = Date.now();
};

socket.onmessage = async function (event) {
    let msg = JSON.parse(event.data);

    if (msg.msgType === "command") {
        if (msg.command === 'm') {
            await memoryStream.printAllMemories(BOT_LOG_MSG);
            return;
        } else if (msg.command === 's') {
            await skillManager.printAllSkills(BOT_LOG_MSG);
            return;
        }

        if (msg.command !== '1') {
            sendMessage(socket, `${BOT_LOG_MSG} Inserisci 1 per avviare.`);
            return;
        }

        await skillManager.init();
        await memoryStream.init(socket);

        while (socket.readyState === WebSocket.OPEN && Date.now() - startTime < DURATION) {

            const status = await getStatus(socket);
            if (!status) continue;

            //  Logica di aggiornamento delle caselle visitate
            if (status["hero position in xy"] && status.depth !== undefined) {
                // Se cambiamo livello del dungeon, svuotiamo la memoria spaziale
                if (status.depth !== currentDepth) {
                    visitedTiles.clear();
                    currentDepth = status.depth;
                    console.log(`${BOT_LOG_MSG} Nuovo livello raggiunto: Profondità ${currentDepth}. Memoria spaziale resettata.`);
                }

                // Aggiungiamo la coordinata attuale formattata (es: "[16, 33]")
                const posStr = `[${status["hero position in xy"].join(", ")}]`;
                visitedTiles.add(posStr);

                // Iniettiamo le ultime 15 posizioni direttamente nello status
                status.visitedTilesList = Array.from(visitedTiles).slice(-15);
            }
            // ----------------------------------------------------------------

            let result = null;

            if (PLANNER_TYPE === "bottomUp") {
                result = await bottomUpActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, TIMEOUT);
            } else if (PLANNER_TYPE === "topDown") {
                result = await topDownActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, SKILL_ROOT_PATH, TIMEOUT);
            } else {
                result = await hybridActions(socket, skillManager, memoryStream, PERSONALITY, RETRIEVE_IS_BOTH, SKILL_ROOT_PATH, TIMEOUT,
                    dCounter, isBottomUp, PLANNER_SWITCH_COND, THRESHOLD_D, THRESHOLD_S);

                if (result) {
                    dCounter = result.cnt;
                    isBottomUp = result.isBottomUp;
                }
            }

            if (result && result.memoryUpdate && result.nextAction) {
                currentTurn++;
                const statusString = status2Prompt(status);

                await memoryStream.addMemory(
                    "event",
                    result.memoryUpdate.success,
                    Date.now(), 0, Date.now(),
                    result.nextAction.task,
                    result.nextAction.action || "",
                    result.nextAction.tile || [],
                    result.nextAction.item1 || "",
                    result.nextAction.item2 || "",
                    /** @type {any} */ (statusString),
                    result.nextAction.reasoning || "",
                    "",
                    result.memoryUpdate.subjective_analysis || "",
                    "", "",
                    result.memoryUpdate.critique || "",
                    ""
                );

                recentTurnsBuffer.push({
                    turn: currentTurn,
                    success: result.memoryUpdate.success,
                    task: result.nextAction.task,
                    subjective_analysis: result.memoryUpdate.subjective_analysis,
                    critique: result.memoryUpdate.critique
                });

                if (recentTurnsBuffer.length >= 20) {
                    console.log(">>> RIFLESSIONE IN CORSO...");
                    await performPeriodicReflection(socket, recentTurnsBuffer, PERSONALITY);
                    recentTurnsBuffer = [];
                }
            }
            // --- RALLENTIAMO IL BOT ---
            // Aspetta 25 secondi tra un turno e l'altro per evitare il ban delle API (Errore 429)
            await sleep(25000);
        }
    }
};

socket.onclose = function () {
    console.log(`Connessione chiusa.`);
};