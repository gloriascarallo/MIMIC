const fetch = require("isomorphic-fetch");
const {sendMessage} = require("./sendMessage");

const AI_LOG_MSG = "bridge.gemini:log";
const AI_ERR_MSG = "bridge.gemini:error";
const EOL = "\n";

/**
 * Call the Google Gemini API (Ex OpenAI bridge)
 */
async function callOpenAI(socket, context, input, LogMsg,
                          model="gemini-2.5-flash",
                          printInput=false, printContext=false, printAnswer=true,
                          isInJSON=true) {

    // --- Ignora le richieste per GPT e forza sempre Gemini ---
    model = "gemini-2.5-flash";

    // Usiamo la chiave passata da terminale
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

    if (!GOOGLE_KEY) {
        sendMessage(socket, `${AI_ERR_MSG} ERROR: GOOGLE_API_KEY is required.`);
        return null;
    }

    if (printContext) sendMessage(socket, `${LogMsg} Context: ${context}${EOL} ${input}${EOL}`);
    if (printInput) sendMessage(socket, `${LogMsg} Input: ${input}${EOL}`);

    let isQualified = false;
    let answer = "";

    while (!isQualified) {
        // Puntiamo direttamente ai server di Google
        const URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_KEY}`;

        // Il formato specifico che Gemini richiede
        const body = {
            contents: [{
                parts: [{ text: `${context}${EOL}${EOL}${input}` }]
            }],
            generationConfig: {
                temperature: 0 // Vogliamo decisioni logiche, non creative
            }
        };

        let response = null;
        while (response === null || response.status === 429) {
            response = await fetch(URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                sendMessage(socket, `${AI_ERR_MSG} API response failed with status: ${response.statusText}`);

                // Se superiamo le richieste al minuto, il bot aspetta 3 secondi e riprova da solo!
                if (response.status === 429 || response.status >= 500) {
                    sendMessage(socket, `${AI_LOG_MSG} Waiting 3 seconds to resend (Rate Limit)...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                }
                const errDetails = await response.text();
                console.error("Dettagli Errore Google:", errDetails);
                return null;
            }
        }

        const data = await response.json();

        // Estraiamo la risposta di Gemini
        try {
            answer = data.candidates[0].content.parts[0].text;
        } catch (e) {
            sendMessage(socket, `${AI_ERR_MSG} Impossibile leggere la risposta: ${e}`);
            return null;
        }

        answer = answer.trim();
        if (printAnswer) sendMessage(socket, `${LogMsg} answer: ${answer}`);

        // Assicuriamoci che Gemini risponda in JSON pulito come richiede il gioco
        if (isInJSON) {
            try {
                isQualified = true;
                answer = answer.replace(/```json/gi, "").replace(/```/g, "").trim();
                JSON.parse(answer); // Testiamo se è un JSON valido
            } catch (e) {
                sendMessage(socket, `${AI_ERR_MSG} Formato JSON non valido, riprovo... ${e}`);
                isQualified = false; // Se sbaglia, il ciclo while lo costringe a riprovare
            }
        } else {
            isQualified = true;
        }
    }

    return answer;
}

module.exports = callOpenAI;