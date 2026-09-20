/**
 * ORACLE — Pattern Learner
 * Learns from past sessions which context was actually useful.
 * Tracks prompt→file associations and builds co-occurrence models.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/** A single session record */
class SessionRecord {
  /**
   * @param {string} prompt
   * @param {string[]} predictedFiles
   * @param {string[]} actuallyUsedFiles
   * @param {number} timestamp
   */
  constructor(prompt, predictedFiles, actuallyUsedFiles, timestamp = Date.now()) {
    this.prompt = prompt;
    this.predictedFiles = predictedFiles;
    this.actuallyUsedFiles = actuallyUsedFiles;
    this.timestamp = timestamp;
  }

  /** Compute prediction accuracy for this session */
  get accuracy() {
    if (this.predictedFiles.length === 0) return 0;
    // Use Set for O(1) lookup instead of O(n*m) filter+includes
    const actualSet = new Set(this.actuallyUsedFiles);
    const hits = this.predictedFiles.filter(f => actualSet.has(f));
    return hits.length / this.predictedFiles.length;
  }

  /** Compute recall — what fraction of actual files were predicted */
  get recall() {
    if (this.actuallyUsedFiles.length === 0) return 1;
    // Use Set for O(1) lookup instead of O(n*m) filter+includes
    const predictedSet = new Set(this.predictedFiles);
    const hits = this.actuallyUsedFiles.filter(f => predictedSet.has(f));
    return hits.length / this.actuallyUsedFiles.length;
  }
}

export class PatternLearner {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir - directory for persistent learning data
   * @param {number} [opts.maxRecords=1000] - max session records to keep
   * @param {number} [opts.decayFactor=0.95] - exponential decay for older records
   * @param {number} [opts.maxCoOccurrenceSize=100] - max co-occurrence entries per file
   */
  constructor({ dataDir, maxRecords = 1000, decayFactor = 0.95, maxCoOccurrenceSize = 100 }) {
    this.dataDir = dataDir;
    this.maxRecords = maxRecords;
    this.decayFactor = decayFactor;
    this.maxCoOccurrenceSize = maxCoOccurrenceSize;
    this.dataFile = join(dataDir, 'patterns.json');

    /** @type {SessionRecord[]} */
    this.records = [];
    /** @type {Map<string, Map<string, number>>} keyword → {file → score} */
    this.keywordFileMap = new Map();
    /** @type {Map<string, string[]>} file → co-occurring files */
    this.coOccurrenceMap = new Map();
    /** @type {Map<string, {useful: number, total: number}>} file → feedback stats */
    this.feedbackMap = new Map();
    /** @type {Map<string, number>} file → last feedback timestamp for decay */
    this.feedbackTimestamps = new Map();
  }

  /**
   * Extract keywords from a prompt (simplified extraction).
   * @param {string} prompt
   * @returns {string[]}
   */
  extractKeywords(prompt) {
    const words = prompt.toLowerCase().match(/[a-z][a-z0-9_.-]+/g) || [];
    const stopWords = new Set([
      'the', 'and', 'for', 'this', 'that', 'with', 'from', 'are', 'was',
      'will', 'can', 'has', 'have', 'been', 'not', 'but', 'all', 'any',
      'you', 'your', 'how', 'what', 'when', 'please', 'help', 'want',
    ]);
    return [...new Set(words)].filter(w => w.length > 2 && !stopWords.has(w));
  }

  /**
   * Record a completed session's prediction results.
   * @param {string} prompt
   * @param {string[]} predictedFiles
   * @param {string[]} actuallyUsedFiles
   */
  recordSession(prompt, predictedFiles, actuallyUsedFiles) {
    try {
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('Invalid prompt: must be a non-empty string');
      }
      if (!Array.isArray(predictedFiles) || !Array.isArray(actuallyUsedFiles)) {
        throw new Error('Invalid files: predictedFiles and actuallyUsedFiles must be arrays');
      }

      const record = new SessionRecord(prompt, predictedFiles, actuallyUsedFiles);
      this.records.push(record);

      // Trim old records
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(-this.maxRecords);
      }

      // Update keyword→file associations based on actual usage
      const keywords = this.extractKeywords(prompt);
      for (const kw of keywords) {
        if (!this.keywordFileMap.has(kw)) {
          this.keywordFileMap.set(kw, new Map());
        }
        const fileMap = this.keywordFileMap.get(kw);
        for (const file of actuallyUsedFiles) {
          fileMap.set(file, (fileMap.get(file) || 0) + 1);
        }
      }

      // Update co-occurrence map with bounded array sizes
      for (const file of actuallyUsedFiles) {
        if (!this.coOccurrenceMap.has(file)) {
          this.coOccurrenceMap.set(file, []);
        }
        const peers = actuallyUsedFiles.filter(f => f !== file);
        const existing = this.coOccurrenceMap.get(file);
        for (const peer of peers) {
          if (!existing.includes(peer)) {
            existing.push(peer);
            // Cap array size to prevent unbounded growth
            if (existing.length > this.maxCoOccurrenceSize) {
              existing.shift(); // Remove oldest entry
            }
          }
        }
      }
    } catch (err) {
      console.error('PatternLearner.recordSession error:', err);
      throw err;
    }
  }

  /**
   * Get learned file suggestions for a prompt with confidence scoring and pattern decay.
   * @param {string} prompt
   * @param {number} [maxSuggestions=15]
   * @returns {Array<{file: string, confidence: number}>}
   */
  suggest(prompt, maxSuggestions = 15) {
    try {
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('Invalid prompt: must be a non-empty string');
      }

      const keywords = this.extractKeywords(prompt);
      /** @type {Map<string, number>} */
      const fileScores = new Map();

      // Cold start: if no history, return empty with graceful handling
      if (this.keywordFileMap.size === 0) {
        return [];
      }

      for (const kw of keywords) {
        const fileMap = this.keywordFileMap.get(kw);
        if (!fileMap) continue;

        for (const [file, count] of fileMap.entries()) {
          fileScores.set(file, (fileScores.get(file) || 0) + count);
        }
      }

      const now = Date.now();
      const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days

      const results = [...fileScores.entries()]
        .map(([file, score]) => {
          let confidence = Math.min(1.0, score / (keywords.length * 3));

          // Apply feedback boost: files that were actually useful get higher confidence
          const feedback = this.feedbackMap.get(file);
          if (feedback && feedback.total > 0) {
            const usefulness = feedback.useful / feedback.total;
            confidence = confidence * 0.7 + usefulness * 0.3;
          }

          // Apply pattern decay: older patterns get less weight
          const lastFeedback = this.feedbackTimestamps.get(file);
          if (lastFeedback) {
            const age = now - lastFeedback;
            const decayMultiplier = Math.max(0.5, 1 - (age / maxAge) * 0.5);
            confidence *= decayMultiplier;
          }

          return { file, confidence: Math.min(1.0, confidence) };
        })
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxSuggestions);

      return results;
    } catch (err) {
      console.error('PatternLearner.suggest error:', err);
      return [];
    }
  }

  /**
   * Record feedback on a prediction: whether it was actually useful.
   * @param {string} file
   * @param {boolean} wasUseful
   */
  recordFeedback(file, wasUseful) {
    try {
      if (!this.feedbackMap.has(file)) {
        this.feedbackMap.set(file, { useful: 0, total: 0 });
      }
      const feedback = this.feedbackMap.get(file);
      feedback.total++;
      if (wasUseful) {
        feedback.useful++;
      }
      this.feedbackTimestamps.set(file, Date.now());
    } catch (err) {
      console.error('PatternLearner.recordFeedback error:', err);
    }
  }

  /**
   * Get prediction confidence for a file based on historical feedback.
   * @param {string} file
   * @returns {number} 0-1 confidence score
   */
  getPredictionConfidence(file) {
    const feedback = this.feedbackMap.get(file);
    if (!feedback || feedback.total === 0) return 0.5; // Default confidence

    const usefulness = feedback.useful / feedback.total;

    // Apply pattern decay
    const lastFeedback = this.feedbackTimestamps.get(file);
    if (!lastFeedback) return usefulness;

    const now = Date.now();
    const age = now - lastFeedback;
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    const decayMultiplier = Math.max(0.5, 1 - (age / maxAge) * 0.5);

    return Math.min(1.0, usefulness * decayMultiplier);
  }

  /**
   * Build a co-occurrence map suitable for FilePredictor integration.
   * @returns {Map<string, string[]>} keyword → co-occurring files
   */
  buildCoOccurrenceMap() {
    try {
      const result = new Map();
      for (const [kw, fileMap] of this.keywordFileMap.entries()) {
        const topFiles = [...fileMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([file]) => file);
        result.set(kw, topFiles);
      }
      return result;
    } catch (err) {
      console.error('PatternLearner.buildCoOccurrenceMap error:', err);
      return new Map();
    }
  }

  /**
   * Compute overall prediction metrics.
   * @returns {{avgAccuracy: number, avgRecall: number, totalSessions: number}}
   */
  getMetrics() {
    if (this.records.length === 0) {
      return { avgAccuracy: 0, avgRecall: 0, totalSessions: 0 };
    }

    // Apply decay weighting
    let totalAccuracy = 0;
    let totalRecall = 0;
    let totalWeight = 0;

    for (let i = 0; i < this.records.length; i++) {
      const weight = Math.pow(this.decayFactor, this.records.length - 1 - i);
      totalAccuracy += this.records[i].accuracy * weight;
      totalRecall += this.records[i].recall * weight;
      totalWeight += weight;
    }

    return {
      avgAccuracy: totalWeight > 0 ? totalAccuracy / totalWeight : 0,
      avgRecall: totalWeight > 0 ? totalRecall / totalWeight : 0,
      totalSessions: this.records.length,
    };
  }

  /**
   * Get accuracy report for the last N sessions with detailed metrics.
   * @param {number} [lastN=50] - number of recent sessions to analyze
   * @returns {{precision: number, recall: number, f1Score: number, sessions: Array}}
   */
  getAccuracyReport(lastN = 50) {
    try {
      if (this.records.length === 0) {
        return {
          precision: 0,
          recall: 0,
          f1Score: 0,
          sessions: [],
          totalSessions: 0,
          analyzedSessions: 0
        };
      }

      const recentRecords = this.records.slice(-lastN);
      let totalPrecision = 0;
      let totalRecall = 0;

      const sessionDetails = recentRecords.map((record, index) => {
        // Precision: what fraction of predicted files were actually used
        const predictedSet = new Set(record.predictedFiles);
        const actualSet = new Set(record.actuallyUsedFiles);

        let truePositives = 0;
        for (const file of record.predictedFiles) {
          if (actualSet.has(file)) truePositives++;
        }

        const precision = record.predictedFiles.length > 0
          ? truePositives / record.predictedFiles.length
          : 0;

        // Recall: what fraction of actual files were predicted
        const recall = record.actuallyUsedFiles.length > 0
          ? truePositives / record.actuallyUsedFiles.length
          : 1; // Perfect recall if no files were needed

        // F1 Score: harmonic mean of precision and recall
        const f1 = (precision + recall) > 0
          ? 2 * (precision * recall) / (precision + recall)
          : 0;

        totalPrecision += precision;
        totalRecall += recall;

        return {
          sessionIndex: this.records.length - lastN + index,
          timestamp: record.timestamp,
          prompt: record.prompt.slice(0, 80) + (record.prompt.length > 80 ? '...' : ''),
          predicted: record.predictedFiles.length,
          actuallyUsed: record.actuallyUsedFiles.length,
          truePositives,
          precision: parseFloat(precision.toFixed(3)),
          recall: parseFloat(recall.toFixed(3)),
          f1Score: parseFloat(f1.toFixed(3))
        };
      });

      const avgPrecision = totalPrecision / recentRecords.length;
      const avgRecall = totalRecall / recentRecords.length;
      const avgF1 = (avgPrecision + avgRecall) > 0
        ? 2 * (avgPrecision * avgRecall) / (avgPrecision + avgRecall)
        : 0;

      return {
        precision: parseFloat(avgPrecision.toFixed(3)),
        recall: parseFloat(avgRecall.toFixed(3)),
        f1Score: parseFloat(avgF1.toFixed(3)),
        sessions: sessionDetails,
        totalSessions: this.records.length,
        analyzedSessions: recentRecords.length
      };
    } catch (err) {
      console.error('PatternLearner.getAccuracyReport error:', err);
      return {
        precision: 0,
        recall: 0,
        f1Score: 0,
        sessions: [],
        totalSessions: this.records.length,
        analyzedSessions: 0
      };
    }
  }

  /**
   * Export accuracy report as JSON.
   * @param {number} [lastN=50] - number of recent sessions to analyze
   * @returns {string} - JSON string
   */
  exportAccuracyReportJSON(lastN = 50) {
    try {
      const report = this.getAccuracyReport(lastN);
      return JSON.stringify(report, null, 2);
    } catch (err) {
      console.error('PatternLearner.exportAccuracyReportJSON error:', err);
      return JSON.stringify({ error: err.message }, null, 2);
    }
  }

  /**
   * Get rolling accuracy history for the last N sessions.
   * Returns a time series of accuracy metrics.
   * @param {number} [lastN=50] - number of recent sessions to analyze
   * @returns {Array<{timestamp: number, precision: number, recall: number, f1Score: number}>}
   */
  getRollingAccuracyHistory(lastN = 50) {
    try {
      if (this.records.length === 0) return [];

      const recentRecords = this.records.slice(-lastN);
      return recentRecords.map(record => {
        const predictedSet = new Set(record.predictedFiles);
        const actualSet = new Set(record.actuallyUsedFiles);

        let truePositives = 0;
        for (const file of record.predictedFiles) {
          if (actualSet.has(file)) truePositives++;
        }

        const precision = record.predictedFiles.length > 0
          ? truePositives / record.predictedFiles.length
          : 0;

        const recall = record.actuallyUsedFiles.length > 0
          ? truePositives / record.actuallyUsedFiles.length
          : 1;

        const f1Score = (precision + recall) > 0
          ? 2 * (precision * recall) / (precision + recall)
          : 0;

        return {
          timestamp: record.timestamp,
          precision: parseFloat(precision.toFixed(3)),
          recall: parseFloat(recall.toFixed(3)),
          f1Score: parseFloat(f1Score.toFixed(3))
        };
      });
    } catch (err) {
      console.error('PatternLearner.getRollingAccuracyHistory error:', err);
      return [];
    }
  }

  /**
   * Persist learned patterns to disk including feedback data.
   * @returns {Promise<void>}
   */
  async save() {
    try {
      const data = {
        version: 2, // Bumped version for feedback data
        timestamp: Date.now(),
        records: this.records.map(r => ({
          prompt: r.prompt,
          predictedFiles: r.predictedFiles,
          actuallyUsedFiles: r.actuallyUsedFiles,
          timestamp: r.timestamp,
        })),
        keywordFileMap: Object.fromEntries(
          [...this.keywordFileMap.entries()].map(([k, v]) => [k, Object.fromEntries(v)])
        ),
        coOccurrenceMap: Object.fromEntries(this.coOccurrenceMap),
        feedbackMap: Object.fromEntries(this.feedbackMap),
        feedbackTimestamps: Object.fromEntries(this.feedbackTimestamps),
      };

      await mkdir(dirname(this.dataFile), { recursive: true });
      await writeFile(this.dataFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('PatternLearner.save error:', err);
      throw err;
    }
  }

  /**
   * Load learned patterns from disk including feedback data.
   * @returns {Promise<boolean>}
   */
  async load() {
    try {
      const raw = await readFile(this.dataFile, 'utf-8');
      const data = JSON.parse(raw);

      this.records = (data.records || []).map(r =>
        new SessionRecord(r.prompt, r.predictedFiles, r.actuallyUsedFiles, r.timestamp)
      );

      this.keywordFileMap = new Map(
        Object.entries(data.keywordFileMap || {}).map(([k, v]) => [k, new Map(Object.entries(v))])
      );

      this.coOccurrenceMap = new Map(
        Object.entries(data.coOccurrenceMap || {})
      );

      // Load feedback data (v2 feature)
      if (data.feedbackMap) {
        this.feedbackMap = new Map(Object.entries(data.feedbackMap));
      }
      if (data.feedbackTimestamps) {
        this.feedbackTimestamps = new Map(Object.entries(data.feedbackTimestamps));
      }

      return true;
    } catch (err) {
      console.warn('PatternLearner.load warning:', err.message);
      return false;
    }
  }

  /** Reset all learned data including feedback. */
  reset() {
    this.records = [];
    this.keywordFileMap = new Map();
    this.coOccurrenceMap = new Map();
    this.feedbackMap = new Map();
    this.feedbackTimestamps = new Map();
  }
}

export { SessionRecord };
export default PatternLearner;
