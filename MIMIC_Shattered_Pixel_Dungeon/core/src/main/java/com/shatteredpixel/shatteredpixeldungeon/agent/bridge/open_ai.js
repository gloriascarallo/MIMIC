require('dotenv').config();
const fetch = require("isomorphic-fetch");
const {sendMessage} = require("./sendMessage");

const AI_LOG_MSG = "bridge.gemini:log";
const AI_ERR_MSG = "bridge.gemini:error";
const EOL = "\n";

// --- VARIABILI GLOBALI PER LA CODA (MUTEX LOCK) ---
let isCallingAPI = false;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callOpenAI(socket, context, input, LogMsg,
                          model="gemini-2.5-flash",
                          printInput=false, printContext=false, printAnswer=true,
                          isInJSON=true) {

    console.log(`[API CALL START] Inizio chiamata per: ${LogMsg}`);
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

    if (!GOOGLE_KEY) {
        sendMessage(socket, `${AI_ERR_MSG} ERROR: GOOGLE_API_KEY is required.`);
        return null;
    }

    if (printContext) sendMessage(socket, `${LogMsg} Context: ${context}${EOL} ${input}${EOL}`);
    if (printInput) sendMessage(socket, `${LogMsg} Input: ${input}${EOL}`);

    // --- LA CODA D'ATTESA (MUTEX) ---
    while (isCallingAPI) {
        await sleep(200);
    }
    isCallingAPI = true;

    let isQualified = false;
    let answer = "";

    try {
        while (!isQualified) {
            const URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_KEY}`;
            const body = {
                contents: [{ parts: [{ text: `${context}${EOL}${EOL}${input}` }] }],
                generationConfig: { temperature: 0 }
            };

            let data = null;
            let currentWaitTime = 15000;
            const maxRetries = 7;

            // --- LOOP RETRY CON BACKOFF ESPONENZIALE ---
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                const response = await fetch(URL, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(body),
                });

                if (!response.ok) {
                    console.error(`\n>>> [ERRORE GOOGLE]: ${response.status} - ${response.statusText}`);
                    if (response.status === 429 || response.status >= 500) {
                        sendMessage(socket, `${AI_LOG_MSG} Google Busy. Tentativo ${attempt}/${maxRetries}. Aspetto ${currentWaitTime / 1000}s...`);
                        await sleep(currentWaitTime);
                        currentWaitTime *= 2;
                        continue;
                    }
                    return null;
                }
                data = await response.json();
                break;
            }

            if (!data) return null;

            try {
                answer = data.candidates[0].content.parts[0].text.trim();
            } catch (e) {
                sendMessage(socket, `${AI_ERR_MSG} Risposta vuota da Google.`);
                return null;
            }

            if (printAnswer) sendMessage(socket, `${LogMsg} answer: ${answer}`);

            // --- PARSER JSON INTELLIGENTE ---
            if (isInJSON) {
                try {
                    const firstBracket = answer.indexOf('{');
                    const lastBracket = answer.lastIndexOf('}');

                    if (firstBracket !== -1 && lastBracket !== -1) {
                        // Estrae solo la parte tra { e }
                        answer = answer.substring(firstBracket, lastBracket + 1).trim();
                    }

                    JSON.parse(answer); // Validazione
                    isQualified = true;
                } catch (e) {
                    sendMessage(socket, `${AI_ERR_MSG} JSON Corrotto, riprovo... ${e}`);
                    isQualified = false;
                }
            } else {
                isQualified = true;
            }
        }

        // --- COOLDOWN RPM (15 RICHIESTE AL MINUTO) ---
        await sleep(20000);
        return answer;

    } finally {
        console.log(`[API CALL END] Fine chiamata per: ${LogMsg}`);
        isCallingAPI = false;
    }
}

module.exports = callOpenAI;