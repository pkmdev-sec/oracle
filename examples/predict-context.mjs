#!/usr/bin/env node

/**
 * ORACLE Example: Predict Context
 *
 * Demonstrates how to:
 * - Use FilePredictor to predict which files are needed for a prompt
 * - Rank predictions with ContextRanker using multi-signal scoring
 * - Display predicted files with confidence scores
 */

import { FilePredictor } from '../lib/file-predictor.mjs';
import { ContextRanker } from '../lib/context-ranker.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use the oracle project itself as the root directory
const ROOT_DIR = join(__dirname, '..');

async function main() {
  console.log('\n🔮 ORACLE — Predict Context Example\n');
  console.log('═'.repeat(60));

  // Sample prompt: fixing an authentication bug
  const prompt = 'fix the authentication bug in the login handler';
  console.log(`\n📝 Prompt: "${prompt}"\n`);

  // Initialize the file predictor
  console.log('Initializing FilePredictor...');
  const predictor = new FilePredictor({
    rootDir: ROOT_DIR,
    maxDepth: 6,
    maxResults: 20
  });

  // Predict which files will be needed
  console.log('Predicting relevant files...\n');
  const predictions = await predictor.predict(prompt);

  console.log(`✓ Found ${predictions.length} predicted files\n`);

  // Get all files for the ranker
  const allFiles = await predictor.getFiles();

  // Extract keywords for TF-IDF scoring
  const keywords = predictor.extractKeywords(prompt);
  console.log(`Keywords extracted: ${keywords.join(', ')}\n`);

  // Initialize the context ranker with multi-signal scoring
  console.log('Initializing ContextRanker...');
  const ranker = new ContextRanker({
    allFiles,
    keywords,
    weights: {
      predictorScore: 0.25,
      recency: 0.20,
      frequency: 0.15,
      proximity: 0.10,
      fileType: 0.10,
      tfidf: 0.15,
      projectStructure: 0.05
    }
  });

  // Rank the predictions
  console.log('Ranking predictions with multi-signal scoring...\n');
  const ranked = ranker.rank(predictions);

  console.log('═'.repeat(60));
  console.log('\n📊 PREDICTION RESULTS (Top 10)\n');
  console.log('═'.repeat(60));

  // Display top 10 results with detailed scoring breakdown
  ranked.slice(0, 10).forEach((item, index) => {
    const confidence = (item.score * 100).toFixed(1);
    const signals = item.signals;

    console.log(`\n${index + 1}. ${item.file}`);
    console.log(`   Confidence: ${confidence}%`);
    console.log(`   Signal Breakdown:`);
    console.log(`     • Predictor Score: ${(signals.predictorScore * 100).toFixed(1)}%`);
    console.log(`     • Recency:        ${(signals.recency * 100).toFixed(1)}%`);
    console.log(`     • Frequency:      ${(signals.frequency * 100).toFixed(1)}%`);
    console.log(`     • Proximity:      ${(signals.proximity * 100).toFixed(1)}%`);
    console.log(`     • File Type:      ${(signals.fileType * 100).toFixed(1)}%`);
    console.log(`     • TF-IDF:         ${(signals.tfidf * 100).toFixed(1)}%`);
    console.log(`     • Structure:      ${(signals.projectStructure * 100).toFixed(1)}%`);
  });

  console.log('\n' + '═'.repeat(60));
  console.log('\n✨ Example complete!\n');
}

// Run the example
main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
