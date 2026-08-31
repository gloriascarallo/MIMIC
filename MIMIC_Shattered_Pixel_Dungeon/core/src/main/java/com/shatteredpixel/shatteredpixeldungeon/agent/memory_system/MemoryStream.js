require('dotenv').config();
const fetch = require("isomorphic-fetch");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
process.env.OPENAI_BASE_URL = "http://localhost:4000/v1";
process.env.OPENAI_API_KEY = "llmnet";

const { ChromaClient, OpenAIEmbeddingFunction, GoogleGenerativeAiEmbeddingFunction } = require("chromadb");
const { listFiles, mkdir, writeFile, loadFile, loadSkills, writeJSON } = require("../utils/file_utils");
const {preferenceAnalyze} = require("../bot_action/preferenceAnalyze");
const {sendMessage} = require("../bridge/sendMessage");

const config = require('../../../../../../../../../config.json');

const OPENAI_API_KEY = config.OPENAI_API_KEY;
const CHROMA_DB_PORT = config.CHROMA_DB_PORT;

const BOT_LOG_MSG = "memory_stream.MemoryStream:log";
const BOT_ERR_MSG = "memory_stream.MemoryStream:error";
const INF = Math.pow(10, 1000);

class Memory{
    constructor(memoryID, memoryType, isSuccess,
                timeCreated, timeExpired, lastAccessed,
                task, action, tile, item1, item2,
                previousStatus, planReason, decideReason, summarizeReason, code, skills, critique, errorMessage) {

        // Basic Info
        this.memoryID = memoryID;
        this.memoryType = memoryType;
        this.isSuccess = isSuccess;

        // Time related
        this.timeCreated = timeCreated;
        this.timeExpired = timeExpired;
        this.lastAccessed = lastAccessed;

        // Relevance parameters
        this.task = task;
        this.action = action;
        this.tile = tile;
        this.item1 = item1;
        this.item2 = item2;

        // Preference parameters
        this.preference = -1;

        // Details
        this.previousStatus = previousStatus;
        this.planReason = planReason;
        this.decideReason = decideReason;
        this.summarizeReason = summarizeReason;
        this.code = code;
        this.skills = skills;
        this.critique = critique;
        this.errorMessage = errorMessage;
    }

    svob_summary(){
        return [this.action, this.item1, this.item2];
    }

    planSummary(){
        return {
            task: this.task,
            isSuccess: this.isSuccess,
            critique: this.critique,
        }
    }

    eventSummary(codeWanted = true){
        if (codeWanted)
            return{
                task: this.task,
                code: this.code,
                previousStatus: this.previousStatus,
                isSuccess: this.isSuccess,
                critique: this.critique,
            };

        return{
            task: this.task,
            previousStatus: this.previousStatus,
            isSuccess: this.isSuccess,
            critique: this.critique,
        }
    }

    errorSummary(codeWanted = true){
        if (codeWanted)
            return{
                task: this.task,
                code: this.code,
                previousStatus: this.previousStatus,
                errorMessage: this.errorMessage,
                critique: this.critique,
            };

        return{
            task: this.task,
            previousStatus: this.previousStatus,
            errorMessage: this.errorMessage,
            critique: this.critique,
        }
    }

    badPlanSummary(){
        return{
            task: this.task,
            critique: this.critique,
        }
    }

    summaryForPA(){
        return{
            isSuccess: this.isSuccess,
            task: this.task,
            previousStatus: this.previousStatus,
            planReason: this.planReason,
            decideReason: this.decideReason,
            summarizeReason: this.summarizeReason,
            critique: this.critique,
        }
    }

    summary(){
        return{
            memoryID: this.memoryID,
            memoryType: this.memoryType,
            isSuccess: this.isSuccess,
            timeCreated: this.timeCreated,
            timeExpired: this.timeExpired,
            lastAccessed: this.lastAccessed,
            task: this.task,
            subject: this.subject,
            verb: this.verb,
            object: this.object,
            biome: this.biome,
            previousStatus: this.previousStatus,
            planReason: this.planReason,
            decideReason: this.decideReason,
            summarizeReason: this.summarizeReason,
            code: this.code,
            skills: this.skills,
            critique: this.critique,
            errorMessage: this.errorMessage,
        }
    }
}

class MemoryStream {
    constructor(socket, rootPath, collectionName, persona, isInherit = false, similarityFunction = "cosine", relevanceTopN = 20, preferenceTopN = 20, topN = 5) {
        this.rootPath = rootPath;
        this.collectionName = collectionName;
        this.persona = persona;
        this.relevanceTopN = relevanceTopN;
        this.preferenceTopN = preferenceTopN;
        this.topN = topN;
        this.isInherit = isInherit;
        this.similarityFunction = similarityFunction;

        this.memoryCount = 0;
        this.memories = {};
        this.events = {};
        this.badPlans = {};
        this.errors = {};
        this.tasks = [];

        this.preferenceOrder = new Map();

        this.sequenceEvent = [];
        this.sequenceBadPlans = [];
        this.latestBadPlans = [];

        // Connessione DIRETTA e GRATUITA ai server di Google per la memoria
        // Embedder personalizzato e RESILIENTE (Anti-Crash)
        this.embedder = {
            generate: async (texts) => {
                let results = [];
                for (let text of texts) {
                    let success = false;
                    let retries = 3;

                    while (!success && retries > 0) {
                        try {
                            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${process.env.GOOGLE_API_KEY}`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    model: "models/gemini-embedding-001",
                                    content: { parts: [{ text: text }] }
                                })
                            });

                            const data = await res.json();

                            if (data.error) {
                                console.log(`[MemoryStream] Server Google API occupato (${data.error.message}). Tentativi rimasti: ${retries - 1}`);
                                retries--;
                                await sleep(15000);
                            } else {
                                results.push(data.embedding.values);
                                success = true;
                                await sleep(5000); // <-- SICUREZZA: Allineato ai 5 secondi
                            }
                        } catch (err) {
                            console.log(`[MemoryStream] Errore di rete: ${err.message}. Tentativi rimasti: ${retries - 1}`);
                            retries--;
                            await sleep(15000);
                        }
                    }

                    if (!success) {
                        console.log(`[MemoryStream] Vettorizzazione fallita definitivamente. Uso un vettore neutro di salvataggio.`);
                        results.push(new Array(768).fill(0));
                    }
                }
                return results;
            }
        };

        this.client = new ChromaClient({
            path: `http://localhost:${CHROMA_DB_PORT}`,
            embeddingFunction: this.embedder,
        });

        this.socket = socket;
    }

    async init(socket) {
        this.personaDescription = await loadFile(`./core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/agent/context/personalities/${this.persona}.txt`, BOT_ERR_MSG);

        mkdir(this.rootPath, "", BOT_LOG_MSG, BOT_ERR_MSG);
        mkdir(this.rootPath, this.persona, BOT_LOG_MSG, BOT_ERR_MSG);
        mkdir(this.rootPath, `${this.persona}/analysis`, BOT_LOG_MSG, BOT_ERR_MSG);

        const tenant = "default_tenant";
        const database = "default_database";

        try {
            await this.client.deleteCollection({
                name: `${this.persona}_memory_collection_${this.collectionName}`,
                tenant,
                database,
            });
            await this.client.deleteCollection({
                name: `${this.persona}_memory_collectionR_${this.collectionName}`,
                tenant,
                database,
            });
            await this.client.deleteCollection({
                name: `${this.persona}_memory_collectionP_${this.collectionName}`,
                tenant,
                database,
            });
        } catch (e) {
            if (!e.message.includes("not be found")) throw e;
        }

        try {
            this.vectorStoreR = await this.client.createCollection({
                name: `${this.persona}_memory_collectionR_${this.collectionName}`,
                tenant,
                database,
                embeddingFunction: this.embedder,
                metadata: { "hnsw:space": this.similarityFunction },
            });
        } catch (e) {
            if (e.message.includes("already exists")) {
                this.vectorStoreR = await this.client.getCollection({
                    name: `${this.persona}_memory_collectionR_${this.collectionName}`,
                    tenant,
                    database,
                    embeddingFunction: this.embedder,
                });
                this.vectorStoreR.embeddingFunction = this.embedder;
            } else {
                throw e;
            }
        }

        try {
            this.vectorStoreP = await this.client.createCollection({
                name: `${this.persona}_memory_collectionP_${this.collectionName}`,
                tenant,
                database,
                embeddingFunction: this.embedder,
                metadata: { "hnsw:space": this.similarityFunction },
            });
        } catch (e) {
            if (e.message.includes("already exists")) {
                this.vectorStoreP = await this.client.getCollection({
                    name: `${this.persona}_memory_collectionP_${this.collectionName}`,
                    tenant,
                    database,
                });
                this.vectorStoreP.embeddingFunction = this.embedder;
            } else {
                throw e;
            }
        }

        if (this.isInherit) {
            try {
                await this.inheritHistory();
                sendMessage(this.socket, `${BOT_LOG_MSG} ${this.persona}_memory_collectionR_${this.collectionName} fetched successfully.`);
                sendMessage(this.socket, `${BOT_LOG_MSG} ${this.persona}_memory_collectionP_${this.collectionName} fetched successfully.`);
            } catch (err) {
                sendMessage(this.socket, `${BOT_ERR_MSG} Error fetching ${this.persona}_memory_collectionR_${this.collectionName}: ${err}`);
                sendMessage(this.socket, `${BOT_ERR_MSG} Error fetching ${this.persona}_memory_collectionP_${this.collectionName}: ${err}`);
            }
        } else {
            await writeJSON(`${this.rootPath}/${this.persona}/${this.persona}.json`, this.memories, BOT_LOG_MSG, BOT_ERR_MSG);

            sendMessage(this.socket, `${BOT_LOG_MSG} ${this.persona}_memory_collectionR_${this.collectionName} created successfully.`);
            sendMessage(this.socket, `${BOT_LOG_MSG} ${this.persona}_memory_collectionP_${this.collectionName} created successfully.`);
        }
    }

    async getCount() {
        return {
            libraryCount: this.memoryCount,
            vectorDBRCount: await this.vectorStoreR.count(),
            vectorDBPCount: await this.vectorStoreP.count(),
            eventCount: Object.keys(this.events).length,
            badPlanCount: Object.keys(this.badPlans).length,
            errorCount: Object.keys(this.errors).length,
        }
    }

    async hasTask(task) {
        return this.tasks.includes(task);
    }

    async inheritHistory() {
        const fs = require('fs');

        let memories = await loadFile(`${this.rootPath}/${this.persona}/${this.persona}.json`, BOT_ERR_MSG);
        memories = JSON.parse(memories);

        for (let i of Object.keys(memories)) {
            let analysis = "";
            const pathAnalisiTxt = `${this.rootPath}/${this.persona}/analysis/id${i}.txt`;

            if (fs.existsSync(pathAnalisiTxt)) {
                analysis = await loadFile(pathAnalisiTxt, BOT_ERR_MSG);
            } else {
                analysis = memories[i].summarizeReason || memories[i].critique || "Disabilitata per risparmio quote";
            }

            await this.addMemory(memories[i].memoryType, memories[i].isSuccess,
                memories[i].timeCreated, memories[i].timeExpired, memories[i].lastAccessed,
                memories[i].task, memories[i].action, memories[i].tile, memories[i].item1, memories[i].item2,
                memories[i].previousStatus, memories[i].planReason, memories[i].decideReason, memories[i].summarizeReason,
                memories[i].code, memories[i].skills, memories[i].critique, memories[i].errorMessage, analysis, true);

            sendMessage(this.socket, `${BOT_LOG_MSG} Loaded memory ${i}. Sleeping to respect rate limits...`);
            await sleep(5000); // <-- FIX PRINCIPALE: 5 secondi per garantire < 15 richieste al minuto
        }
    }

    async addMemory(memoryType, isSuccess,
                    timeCreated, timeExpired, lastAccessed,
                    task, action, tile, item1, item2,
                    previousStatus, planReason, decideReason, summarizeReason,
                    code, skills, critique, errorMessage, analysis = "", isInheriting = false) {

        const memoryID = this.memoryCount;
        this.tasks.push(task);

        const newMemory = new Memory(memoryID, memoryType, isSuccess,
            timeCreated, timeExpired, lastAccessed,
            task, action, tile, item1, item2,
            previousStatus, planReason, decideReason, summarizeReason, code, skills, critique, errorMessage);

        this.memories[memoryID] = newMemory;

        if (!isInheriting) {
            await writeJSON(`${this.rootPath}/${this.persona}/${this.persona}.json`,
                this.memories, BOT_LOG_MSG, BOT_ERR_MSG);
            analysis= "Disabilitata per risparmio quote";
        }

        if (memoryType === "event") {
            this.events[memoryID] = newMemory;
            this.sequenceEvent.push(newMemory);

        } else if (memoryType === "badPlan") {
            this.badPlans[memoryID] = newMemory;
            this.sequenceBadPlans.push(newMemory);
            this.latestBadPlans.push(newMemory);

        } else {
            this.errors[memoryID] = newMemory;
        }

        this.memoryCount++;

        try {
            await this.vectorStoreR.add({
                ids: [(this.memoryCount - 1).toString()],
                metadatas: [{ memoryID: (this.memoryCount - 1).toString(), task: task, memoryType: memoryType}],
                documents: [previousStatus],
            });
        } catch (e) {
            sendMessage(this.socket, `${BOT_ERR_MSG} Failed to store memory ${(this.memoryCount - 1).toString()} in vectorStoreR. Error: ${e.message}`);
        }

        try {
            await this.vectorStoreP.add({
                ids: [(this.memoryCount - 1).toString()],
                metadatas: [{ memoryID: (this.memoryCount - 1).toString(), task: task, memoryType: memoryType}],
                documents: [previousStatus],
            });
        } catch (e) {
            sendMessage(this.socket, `${BOT_ERR_MSG} Failed to store memory ${(this.memoryCount - 1).toString()} in vectorStoreP. Error: ${e.message}`);
        }

        if (memoryType === "badPlan") {
            newMemory.preference = INF;
            return newMemory;
        }

        newMemory.preference = await this.getPreferenceValue(this.memoryCount - 1, analysis);
        this.preferenceOrder.set(memoryID, newMemory.preference);
        this.preferenceOrder = new Map([...this.preferenceOrder.entries()].sort((a, b) => a[1] - b[1]));

        return newMemory;
    }

    getRelevantMemories(subject, verb, object, biome, memoryType="") {
        const memories = {};

        for(const id in this.memories){
            if(memoryType !== "" && this.memories[id].memoryType !== memoryType){
                continue;
            }

            const mySvob = this.memories[id].svob_summary();

            if(mySvob[0] === object ||
                mySvob[1] === verb ||
                mySvob[2] === subject || mySvob[2] === object ||
                mySvob[3] === biome){
                memories[id] = this.memories[id];
            }
        }
        return memories;
    }

    async retrieveMemories(query, isBoth=false, alpha=0.5, beta=1, numNeeded=20, isIDOnly=true, isPrint=true) {
        if (isBoth) {
            const topR = await this.vectorStoreR.query({
                nResults: numNeeded/2,
                queryTexts: [query],
                where: {"$or": [{"memoryType": "event"}, {"memoryType": "error"}]},
            });

            const topRIDs = topR.ids[0];

            let topRMemories = [];
            for (let i = 0; i < topRIDs.length; i++) {
                topRIDs[i] = parseInt(topRIDs[i]);
                topRMemories.push(this.memories[topRIDs[i]]);
            }

            const topPMap = new Map(Array.from(this.preferenceOrder).slice(0, numNeeded/2));
            const topPIDs = Array.from(topPMap.keys());
            const topPMemories = [];
            const topP_PValues = Array.from(topPMap.values());
            for (let id of topPIDs) {
                topPMemories.push(this.memories[id]);
            }

            if (isPrint){
                sendMessage(this.socket, `${BOT_LOG_MSG} Memories Retrieved by "${query}":\n\t${topRIDs}\nThe R values are: ${topR.distances[0]}`);
                sendMessage(this.socket, `${BOT_LOG_MSG} Memories Retrieved by Preference: ${topPIDs}\nThe P values are: ${topP_PValues}`);
            }

            if (isIDOnly) return {
                R: topRIDs,
                P: topPIDs,
            };

            return {
                R: topRMemories,
                P: topPMemories,
            };
        }

        let UValueMap = new Map();

        const topR = await this.vectorStoreR.query({
            nResults: numNeeded,
            queryTexts: [query],
            where: {"$or": [{"memoryType": "event"}, {"memoryType": "error"}]},
        });

        const topRIDs = topR.ids[0];
        const topR_RValues = topR.distances[0];

        const topR_PValues = [];
        const topR_UValues = [];
        for (let i = 0; i < topRIDs.length; i++) {
            topRIDs[i] = parseInt(topRIDs[i]);
            let id = topRIDs[i];
            let memory = this.memories[id];

            let R = topR_RValues[i];
            let P = memory.preference;
            let U = alpha * R + beta * P;
            UValueMap.set(id, U);

            topR_PValues.push(P);
            topR_UValues.push(U);
        }

        const topPMap = new Map(Array.from(this.preferenceOrder).slice(0, numNeeded));
        const topPIDs = Array.from(topPMap.keys());
        const topPMemories = [];
        const topP_PValues = Array.from(topPMap.values());

        for (let id of topPIDs) {
            if (topRIDs.includes(id)) {
                const index = topPIDs.indexOf(id);
                topPIDs.splice(index, 1);
            }
        }

        const topP_RValues = await this.getRelevanceValues(topPIDs, query);
        const topP_UValues = [];
        for (let i = 0; i < topPIDs.length; i++) {
            topPIDs[i] = parseInt(topPIDs[i]);
            let id = topPIDs[i];
            let memory = this.memories[id];

            let R = topP_RValues[i];
            let P = topP_PValues[i];
            let U = alpha * R + beta * P;
            UValueMap.set(id, U);

            topPMemories.push(memory);
            topP_UValues.push(U);
        }

        UValueMap = new Map([...UValueMap.entries()].sort((a, b) => a[1] - b[1]));
        const topUMap = new Map(Array.from(UValueMap).slice(0, numNeeded));
        const topUIDs = Array.from(topUMap.keys());
        const topUMemories = Array.from(topUMap.entries());

        if (isPrint){
            sendMessage(this.socket,`${BOT_LOG_MSG} Memories Retrieved by \n\t"${query}":\n\t${topRIDs}\nThe R values are: ${topR_RValues}\nThe P values are: ${topR_PValues}\nThe U values are: ${topR_UValues}`);
            sendMessage(this.socket, `${BOT_LOG_MSG} Memories Retrieved by Preference: ${topPIDs}\nThe R values are: ${topP_RValues}\nThe P values are: ${topP_PValues}\nThe U values are: ${topP_UValues}`);
        }

        if (isIDOnly) return topUIDs;
        return topUMemories;
    }

    async retrievePastRecentMemories(numNeeded=5) {
        let memories = this.sequenceEvent.slice(-numNeeded);
        let results = [];

        for (let memory of memories) {
            results.push(JSON.stringify(memory.planSummary()));
        }

        return results;
    }

    async getRelevanceValues(ids, query){
        let RValues = [];

        for (let id of ids) {
            id = id.toString();

            const relRes = await this.vectorStoreR.query({
                nResults: 1,
                queryTexts: [query],
                where: { "memoryID": id },
            });

            RValues.push(relRes.distances[0][0]);
        }

        return RValues;
    }

    async getPreferenceValue(id, analysis) {
        if (analysis) analysis = analysis.replaceAll('\n', '');
        let m = id.toString();

        const relRes = await this.vectorStoreP.query({
            nResults: 1,
            queryTexts: [this.personaDescription],
            where: { "memoryID": m },
        });

        // FIX: Controllo di sicurezza Anti-Crash per ChromaDB
        if (!relRes.distances || !relRes.distances[0] || relRes.distances[0].length === 0) {
            sendMessage(this.socket, `${BOT_LOG_MSG} Warning: ChromaDB non ha trovato l'ID ${m} in tempo. Assegnata preferenza neutra.`);
            return 0.5; // Valore di fallback
        }

        sendMessage(this.socket, `${BOT_LOG_MSG} id: ${id}, relResID: ${relRes.ids[0][0]}, Preference: ${relRes.distances[0][0]}`);

        return relRes.distances[0][0];
    }

    clearLatestBadPlans() {
        this.latestBadPlans = [];
    }

    async printAllMemories(logName) {
        sendMessage(this.socket, `${logName} The number is: ${await JSON.stringify(this.getCount())}\nThe memories are:\n${JSON.stringify(this.memories)}`);
    }

    async clean() {
        await this.client.deleteCollection({name: `${this.persona}_memory_collection_${this.collectionName}`});
    }
}

module.exports = {
    Memory,
    MemoryStream,
};