const fetch = require("isomorphic-fetch");
const {sendMessage} = require("./sendMessage");

const AI_LOG_MSG = "bridge.gemini:log";
const AI_ERR_MSG = "bridge.gemini:error";
const EOL = "\n";

// --- VARIABILI GLOBALI PER LA CODA (MUTEX LOCK) ---
let isCallingAPI = false;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Call the Google Gemini API (Ex OpenAI bridge)
 */
async function callOpenAI(socket, context, input, LogMsg,
                          model="gemini-2.5-flash",
                          printInput=false, printContext=false, printAnswer=true,
                          isInJSON=true) {

    model = "gemini-2.5-flash";
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

    if (!GOOGLE_KEY) {
        sendMessage(socket, `${AI_ERR_MSG} ERROR: GOOGLE_API_KEY is required.`);
        return null;
    }

    if (printContext) sendMessage(socket, `${LogMsg} Context: ${context}${EOL} ${input}${EOL}`);
    if (printInput) sendMessage(socket, `${LogMsg} Input: ${input}${EOL}`);

    // --- LA CODA D'ATTESA ---
    // Se c'è già un'altra richiesta in corso, aspetta qui finché non ha finito.
    while (isCallingAPI) {
        await sleep(200); // Controllo del semaforo ogni 200 millisecondi
    }

    // SCATTA IL ROSSO: Ora può fare una richiesta, nessun altro può fare richieste
    isCallingAPI = true;

    let isQualified = false;
    let answer = "";

    try {
        while (!isQualified) {
            const URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_KEY}`;

            const body = {
                contents: [{
                    parts: [{ text: `${context}${EOL}${EOL}${input}` }]
                }],
                generationConfig: {
                    temperature: 0
                }
            };

            let data = null;

            while (true) {
                const response = await fetch(URL, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(body),
                });

                if (!response.ok) {
                    const errDetails = await response.text();
                    let googleWaitTime = 15000;

                    try {
                        const errorJson = JSON.parse(errDetails);
                        const retryInfo = errorJson.error.details.find(d => d.retryDelay);
                        if (retryInfo) {
                            googleWaitTime = parseInt(retryInfo.retryDelay.replace('s', '')) * 1000 + 1000;
                        }
                    } catch (e) {}

                    console.error(`\n>>> [ERRORE GOOGLE DETTAGLIATO]: ${response.status} - ${response.statusText}\n`);

                    if (response.status === 429 || response.status >= 500) {
                        sendMessage(socket, `${AI_LOG_MSG} Google chiede di rallentare. Aspetto ${googleWaitTime / 1000} secondi...`);
                        await sleep(googleWaitTime);
                        continue;
                    }

                    console.error("Dettagli completi:", errDetails);
                    return null; // Errore irreversibile
                }

                data = await response.json();
                break; // Richiesta andata a buon fine
            }

            try {
                answer = data.candidates[0].content.parts[0].text;
            } catch (e) {
                sendMessage(socket, `${AI_ERR_MSG} Impossibile leggere la risposta: ${e}`);
                return null;
            }

            answer = answer.trim();
            if (printAnswer) sendMessage(socket, `${LogMsg} answer: ${answer}`);

            if (isInJSON) {
                try {
                    isQualified = true;
                    answer = answer.replace(/```json/gi, "").replace(/```/g, "").trim();
                    JSON.parse(answer);
                } catch (e) {
                    sendMessage(socket, `${AI_ERR_MSG} Formato JSON non valido, riprovo... ${e}`);
                    isQualified = false;
                }
            } else {
                isQualified = true;
            }
        }

        // --- PAUSA OBBLIGATORIA DOPO IL SUCCESSO ---
        // Prima di far passare la prossima richiesta in coda, aspetta 8 secondi
        await sleep(8000);

        return answer;

    } finally {
        // --- SCATTA IL VERDE ---
        // Qualsiasi cosa sia successa (successo o errore), libera il semaforo per la prossima richiesta
        isCallingAPI = false;
    }
}

module.exports = callOpenAI;