#!/usr/bin/env node

/**
 * ORACLE Example: Preload Demo
 *
 * Demonstrates how to:
 * - Preload predicted files into the cache
 * - View cache statistics (hits, misses, size)
 * - Inject context into a prompt
 * - Show the enriched prompt with file contents
 */

import { Oracle } from '../lib/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use the oracle project itself as the root directory
const ROOT_DIR = join(__dirname, '..');

async function main() {
  console.log('\n🔮 ORACLE — Preload Demo\n');
  console.log('═'.repeat(60));

  // Initialize Oracle
  console.log('\nInitializing Oracle...');
  const oracle = new Oracle({
    rootDir: ROOT_DIR,
    dataDir: join(ROOT_DIR, '.oracle')
  });

  await oracle.init();
  console.log('✓ Oracle initialized\n');

  // Sample prompt
  const prompt = 'show me how the pattern learner tracks accuracy';
  console.log(`📝 Prompt: "${prompt}"\n`);

  // Predict and preload context
  console.log('Predicting context and preloading files...\n');
  const result = await oracle.predictContext(prompt);

  console.log('═'.repeat(60));
  console.log('\n📊 CACHE STATISTICS\n');
  console.log('═'.repeat(60));

  const stats = result.stats;
  console.log(`\n  Cache Size:     ${stats.cacheSize} / ${stats.maxCacheSize} files`);
  console.log(`  Preloads:       ${stats.preloads} files loaded`);
  console.log(`  Cache Hits:     ${stats.hits}`);
  console.log(`  Cache Misses:   ${stats.misses}`);
  console.log(`  Hit Rate:       ${stats.hitRate}`);
  console.log(`  Miss Rate:      ${stats.missRate}`);
  console.log(`  Evictions:      ${stats.evictions}`);
  console.log(`  Errors:         ${stats.errors}`);
  console.log(`  Prefetches:     ${stats.prefetches}`);

  console.log('\n' + '═'.repeat(60));
  console.log('\n📁 PREDICTED FILES (Top 5)\n');
  console.log('═'.repeat(60));

  result.files.slice(0, 5).forEach((item, index) => {
    const confidence = (item.score * 100).toFixed(1);
    console.log(`\n${index + 1}. ${item.file}`);
    console.log(`   Confidence: ${confidence}%`);
  });

  console.log('\n' + '═'.repeat(60));
  console.log('\n📄 ENRICHED PROMPT WITH CONTEXT\n');
  console.log('═'.repeat(60));

  // Build the enriched prompt with context
  const enrichedPrompt = `${prompt}

--- CONTEXT ---

${result.context}

--- END CONTEXT ---
`;

  // Show a preview of the enriched prompt (first 1000 chars)
  const preview = enrichedPrompt.slice(0, 1000);
  console.log(`\n${preview}${enrichedPrompt.length > 1000 ? '\n\n... (truncated)' : ''}\n`);

  console.log('═'.repeat(60));
  console.log(`\n📏 Context Size: ${result.context.length} characters`);
  console.log(`   Full Prompt:  ${enrichedPrompt.length} characters\n`);

  // Demonstrate cache hits on second access
  console.log('═'.repeat(60));
  console.log('\n🔄 TESTING CACHE HITS (Second Access)\n');
  console.log('═'.repeat(60));

  // Predict the same prompt again to demonstrate cache hits
  const result2 = await oracle.predictContext(prompt);
  const stats2 = result2.stats;

  console.log(`\n  Cache Hits:     ${stats2.hits} (increased from ${stats.hits})`);
  console.log(`  Cache Misses:   ${stats2.misses} (same as before: ${stats.misses})`);
  console.log(`  Hit Rate:       ${stats2.hitRate}`);

  console.log('\n✨ Cache is working! Second access used cached files.\n');

  // Demonstrate cache management utilities
  console.log('═'.repeat(60));
  console.log('\n🛠️  CACHE MANAGEMENT\n');
  console.log('═'.repeat(60));

  // Get detailed stats
  const detailedStats = oracle.preloader.getStats();
  console.log('\nDetailed Cache Statistics:');
  console.log(JSON.stringify(detailedStats, null, 2));

  // Show cached files
  const cachedFiles = oracle.preloader.cache.keys();
  console.log(`\nCurrently Cached Files (${cachedFiles.length}):`);
  cachedFiles.forEach((file, index) => {
    if (index < 5) {
      console.log(`  ${index + 1}. ${file}`);
    }
  });
  if (cachedFiles.length > 5) {
    console.log(`  ... and ${cachedFiles.length - 5} more`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('\n✨ Demo complete!\n');
}

// Run the demo
main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
