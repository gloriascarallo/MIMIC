const http = require('http');
const { sendMessage } = require("./sendMessage");

async function callOpenAI(socket, context, input, LogMsg, model="gpt-4o", printInput=false, printContext=false, printAnswer=true, isInJSON=true) {
    console.log(`[API CALL START] Inizio chiamata per: ${LogMsg}`);

    const postData = JSON.stringify({
        model: model,
        messages: [{ role: "system", content: context }, { role: "user", content: input }],
        stream: false,
        format: isInJSON ? "json" : undefined,
        options: { temperature: 0.5 }
    });

    return new Promise((resolve) => {
        const options = {
            hostname: '127.0.0.1',
            port: 11434,
            path: '/api/chat',
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
                    if (data && data.message && data.message.content) {
                        const answer = data.message.content.trim();
                        if (printAnswer) sendMessage(socket, `${LogMsg} answer: ${answer}`);
                        console.log(`[API CALL END] Fine chiamata per: ${LogMsg}`);
                        resolve(answer);
                    } else {
                        console.error("DEBUG: Risposta vuota o formato errato da Ollama:", responseData);
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