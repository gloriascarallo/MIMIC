const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const csvFilePath = path.join(logsDir, `metrics_session_${timestamp}.csv`);

// --- 1. INTESTAZIONE CSV ---
fs.writeFileSync(csvFilePath, "Turno,Latenza_s,AvgLatenza_s,Modalita\n");

let turnCount = 0;
let totalLatency = 0;

// --- 2. FUNZIONE ---
function logTurn(latency, mode) {
    turnCount++;
    totalLatency += latency;
    const avgLatency = totalLatency / turnCount;

    // --- 3. RIGA CSV AGGIORNATA ---
    const csvLine = `${turnCount},${latency.toFixed(3)},${avgLatency.toFixed(3)},${mode}\n`;
    fs.appendFileSync(csvFilePath, csvLine);

    // --- 4. LOG A SCHERMO ---
    console.log(`[TURNO ${turnCount} | ${mode}] Latenza: ${latency.toFixed(2)}s`);
}

module.exports = { logTurn };