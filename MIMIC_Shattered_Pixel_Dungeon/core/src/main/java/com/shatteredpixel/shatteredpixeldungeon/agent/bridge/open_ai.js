const http = require('http');
const { sendMessage } = require("./sendMessage");

async function callOpenAI(socket, context, input, LogMsg, model="local-model", printInput=false, printContext=false, printAnswer=true, isInJSON=true) {
    console.log(`[API CALL START] Inizio chiamata per: ${LogMsg}`);

    // Formato payload standard OpenAI / LM Studio
    const postData = JSON.stringify({
        model: model,
        messages: [{ role: "system", content: context }, { role: "user", content: input }],
        stream: false,
        temperature: 0.5,
        // response_format: isInJSON ? { type: "json_object" } : undefined // Toglilo se causa problemi
    });

    return new Promise((resolve) => {
        const options = {
            hostname: '127.0.0.1',
            port: 1234, // <-- PORTA DI LM STUDIO
            path: '/v1/chat/completions', // <-- ENDPOINT DI LM STUDIO / OPENAI
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => responseData += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(responseData);
                    // Parsing nel formato OpenAI / LM Studio (diverso da Ollama)
                    if (data && data.choices && data.choices[0] && data.choices[0].message) {
                        const answer = data.choices[0].message.content.trim();
                        if (printAnswer) sendMessage(socket, `${LogMsg} answer: ${answer}`);
                        console.log(`[API CALL END] Fine chiamata per: ${LogMsg}`);
                        resolve(answer);
                    } else {
                        console.error("DEBUG: Risposta vuota o formato errato da LM Studio:", responseData);
                        resolve(null);
                    }
                } catch (e) {
                    console.error("DEBUG: Errore parsing JSON:", e);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.error(`\n>>> [ERRORE DI RETE]: ${e.message}`);
            resolve(null);
        });

        req.write(postData);
        req.end();
    });
}

module.exports = callOpenAI;