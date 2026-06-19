class EvaluationMetrics {
    constructor(totalPossibleCombinations, totalReachableLocations) {
        this.totalPossibleCombinations = totalPossibleCombinations;
        this.totalReachableLocations = totalReachableLocations;
        this.exploredInteractions = new Set();
        this.visitedLocations = new Set();
        this.actionHistory = [];
    }

    recordInteraction(actionType, subjectItem, target, isCarryingItem, hasUpgrade) {
        const interactionKey = `${actionType}|${subjectItem}|${target}|${isCarryingItem}|${hasUpgrade}`;
        this.exploredInteractions.add(interactionKey);
        this.actionHistory.push(actionType);
    }

    recordLocation(locationId) {
        this.visitedLocations.add(locationId);
    }

    calculateCombinatorialCoverage() {
        if (this.totalPossibleCombinations === 0) return 0.0;
        return (this.exploredInteractions.size / this.totalPossibleCombinations) * 100.0;
    }

    calculateNavigationCoverage() {
        if (this.totalReachableLocations === 0) return 0.0;
        return (this.visitedLocations.size / this.totalReachableLocations) * 100.0;
    }

    calculateShannonEntropy(nGram) {
        if (this.actionHistory.length < nGram) return 0.0;

        const nGramCounts = {};
        const totalNGrams = this.actionHistory.length - nGram + 1;

        for (let i = 0; i < totalNGrams; i++) {
            const nGramArr = this.actionHistory.slice(i, i + nGram);
            const nGramKey = nGramArr.join("-");
            nGramCounts[nGramKey] = (nGramCounts[nGramKey] || 0) + 1;
        }

        let entropy = 0.0;
        for (const key in nGramCounts) {
            const probability = nGramCounts[key] / totalNGrams;
            entropy -= probability * (Math.log(probability) / Math.log(2));
        }

        return entropy;
    }

    printMetrics() {
        console.log("\n========== METRICHE DI VALUTAZIONE ==========");
        console.log(`Copertura Combinatoriale: ${this.calculateCombinatorialCoverage().toFixed(2)}% (${this.exploredInteractions.size}/${this.totalPossibleCombinations})`);
        console.log(`Copertura di Navigazione: ${this.calculateNavigationCoverage().toFixed(2)}% (${this.visitedLocations.size}/${this.totalReachableLocations})`);
        console.log(`Diversità Soluzione (1-gram): ${this.calculateShannonEntropy(1).toFixed(4)}`);
        console.log(`Diversità Soluzione (2-gram): ${this.calculateShannonEntropy(2).toFixed(4)}`);
        console.log("=============================================\n");
    }
}

module.exports = { EvaluationMetrics };