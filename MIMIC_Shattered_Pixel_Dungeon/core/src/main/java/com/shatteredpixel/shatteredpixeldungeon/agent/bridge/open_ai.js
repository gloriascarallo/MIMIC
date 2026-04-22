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
                          model="gpt-4o",
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

    // Sicurezza contro i Loop Infiniti di JSON corrotto
    let formatAttempts = 0;
    const maxFormatAttempts = 3;

    try {

        while (!isQualified && formatAttempts < maxFormatAttempts) {
            formatAttempts++;

            const URL = `http://localhost:4000/v1/chat/completions`;

            const body = {
                model: model,
                messages: [
                    { role: "system", content: context },
                    { role: "user", content: input }
                ],
                temperature: 0
            };

            let data = null;
            let currentWaitTime = 10000; // Partiamo da 10 secondi
            const maxRetries = 3; // <-- Ridotto da 7 a 3 per non far impazzire il bot

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                const response = await fetch(URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer llmnet`
                    },
                    body: JSON.stringify(body),
                });

                if (!response.ok) {
                    console.error(`\n>>> [ERRORE PROXY]: ${response.status} - ${response.statusText}`);
                    if (response.status === 429 || response.status >= 500) {
                        sendMessage(socket, `${AI_LOG_MSG} Proxy/Google occupato. Tentativo ${attempt}/${maxRetries}... Attesa ${currentWaitTime/1000}s`);
                        await sleep(currentWaitTime);
                        currentWaitTime *= 2; // Backoff esponenziale
                        continue;
                    }
                    return null;
                }
                data = await response.json();
                break;
            }

            if (!data) return null;

            try {
                answer = data.choices[0].message.content.trim();
            } catch (e) {
                sendMessage(socket, `${AI_ERR_MSG} Formato risposta inaspettato dal proxy.`);
                return null;
            }

            if (printAnswer) sendMessage(socket, `${LogMsg} answer: ${answer}`);

            // --- PARSER JSON INTELLIGENTE ---
            if (isInJSON) {
                try {
                    const firstBracket = answer.indexOf('{');
                    const lastBracket = answer.lastIndexOf('}');

                    if (firstBracket !== -1 && lastBracket !== -1) {
                        answer = answer.substring(firstBracket, lastBracket + 1).trim();
                    }

                    JSON.parse(answer); // Validazione
                    isQualified = true;
                } catch (e) {
                    sendMessage(socket, `${AI_ERR_MSG} JSON Corrotto (Tentativo ${formatAttempts}/${maxFormatAttempts}). Riprovo...`);
                    isQualified = false;
                    // Se falliamo 3 volte, fermiamo tutto per non esaurire la quota
                    if (formatAttempts >= maxFormatAttempts) {
                        sendMessage(socket, `${AI_ERR_MSG} Impossibile ottenere un JSON valido dopo ${maxFormatAttempts} tentativi. Annullamento.`);
                        return null;
                    }
                }
            } else {
                isQualified = true;
            }
        }

        // --- COOLDOWN RPM ---
        // 10 secondi bastano (insieme agli altri sleep) per restare sotto le 15 RPM
        await sleep(10000);
        return answer;

    } finally {
        console.log(`[API CALL END] Fine chiamata per: ${LogMsg}`);
        isCallingAPI = false;
    }
}

module.exports = callOpenAI;