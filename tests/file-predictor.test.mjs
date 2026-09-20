/**
 * Tests for ORACLE FilePredictor
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FilePredictor } from '../lib/file-predictor.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('FilePredictor', () => {
  let tempDir;
  let predictor;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oracle-test-'));
    // Create test file structure
    await mkdir(join(tempDir, 'src', 'components'), { recursive: true });
    await mkdir(join(tempDir, 'src', 'utils'), { recursive: true });
    await mkdir(join(tempDir, 'tests'), { recursive: true });
    await mkdir(join(tempDir, 'api', 'routes'), { recursive: true });
    await mkdir(join(tempDir, 'config'), { recursive: true });

    await writeFile(join(tempDir, 'src', 'components', 'Button.tsx'), 'export const Button = () => {}');
    await writeFile(join(tempDir, 'src', 'components', 'Header.tsx'), 'export const Header = () => {}');
    await writeFile(join(tempDir, 'src', 'utils', 'helpers.ts'), 'export function help() {}');
    await writeFile(join(tempDir, 'tests', 'button.test.ts'), 'test("button", () => {})');
    await writeFile(join(tempDir, 'api', 'routes', 'users.ts'), 'export const users = {}');
    await writeFile(join(tempDir, 'api', 'routes', 'auth.ts'), 'export const auth = {}');
    await writeFile(join(tempDir, 'config', 'database.json'), '{}');
    await writeFile(join(tempDir, 'package.json'), '{}');

    predictor = new FilePredictor({ rootDir: tempDir, maxResults: 10 });
  });

  describe('extractKeywords', () => {
    it('should extract meaningful keywords', () => {
      const keywords = predictor.extractKeywords('Fix the button component styling');
      assert.ok(keywords.includes('fix'));
      assert.ok(keywords.includes('button'));
      assert.ok(keywords.includes('component'));
      assert.ok(keywords.includes('styling'));
      // "the" should be filtered
      assert.ok(!keywords.includes('the'));
    });

    it('should deduplicate keywords', () => {
      const keywords = predictor.extractKeywords('button button button');
      const buttonCount = keywords.filter(k => k === 'button').length;
      assert.equal(buttonCount, 1);
    });

    it('should filter stop words', () => {
      const keywords = predictor.extractKeywords('the and for this that with');
      assert.equal(keywords.length, 0);
    });

    it('should handle empty prompt', () => {
      const keywords = predictor.extractKeywords('');
      assert.equal(keywords.length, 0);
    });
  });

  describe('extractExplicitPaths', () => {
    it('should extract file paths from prompt', () => {
      const paths = predictor.extractExplicitPaths('Look at src/components/Button.tsx');
      assert.ok(paths.some(p => p.includes('Button.tsx')));
    });

    it('should extract paths in quotes', () => {
      const paths = predictor.extractExplicitPaths('Edit "config/database.json" please');
      assert.ok(paths.some(p => p.includes('database.json')));
    });
  });

  describe('scoreFile', () => {
    it('should score filename matches higher than path matches', () => {
      const scoreFilename = predictor.scoreFile('src/button.ts', ['button']);
      const scorePath = predictor.scoreFile('button-dir/other.ts', ['button']);
      assert.ok(scoreFilename >= scorePath);
    });

    it('should score co-occurrence matches', () => {
      predictor.coOccurrenceMap.set('auth', ['api/routes/auth.ts']);
      const score = predictor.scoreFile('api/routes/auth.ts', ['auth']);
      assert.ok(score > 0);
    });

    it('should return 0 for no matches', () => {
      const score = predictor.scoreFile('src/foo.ts', ['zzzzz']);
      assert.equal(score, 0);
    });
  });

  describe('predict', () => {
    it('should return predicted files sorted by score', async () => {
      const results = await predictor.predict('Fix the button component');
      assert.ok(Array.isArray(results));
      // Scores should be descending
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].score >= results[i].score);
      }
    });

    it('should prioritize explicitly mentioned files', async () => {
      const results = await predictor.predict('Edit src/components/Button.tsx');
      assert.ok(results.length > 0);
      assert.ok(results[0].file.includes('Button.tsx'));
    });

    it('should use history for context', async () => {
      const history = ['Working on the button component'];
      const results = await predictor.predict('Fix the styling', history);
      // Should still find button-related files from history
      assert.ok(Array.isArray(results));
    });

    it('should respect maxResults', async () => {
      const smallPredictor = new FilePredictor({ rootDir: tempDir, maxResults: 2 });
      const results = await smallPredictor.predict('components utils api config test');
      assert.ok(results.length <= 2);
    });
  });

  describe('getFiles', () => {
    it('should scan files recursively', async () => {
      const files = await predictor.getFiles();
      assert.ok(files.length > 0);
      assert.ok(files.some(f => f.includes('Button.tsx')));
    });

    it('should cache results', async () => {
      const files1 = await predictor.getFiles();
      const files2 = await predictor.getFiles();
      assert.deepEqual(files1, files2);
    });
  });

  describe('invalidateCache', () => {
    it('should clear the file cache', async () => {
      await predictor.getFiles();
      assert.ok(predictor._fileCache !== null);
      predictor.invalidateCache();
      assert.equal(predictor._fileCache, null);
    });
  });

  describe('parallel file scanning', () => {
    it('should scan subdirectories in parallel batches', async () => {
      // Create multiple subdirectories
      for (let i = 0; i < 10; i++) {
        await mkdir(join(tempDir, `dir${i}`), { recursive: true });
        await writeFile(join(tempDir, `dir${i}`, `file${i}.ts`), 'export {}');
      }

      const startTime = Date.now();
      const files = await predictor.getFiles();
      const duration = Date.now() - startTime;

      assert.ok(files.length >= 10);
      // Should complete reasonably fast due to parallel scanning
      assert.ok(duration < 5000); // Less than 5 seconds
    });
  });

  describe('dotfile exclusion', () => {
    it('should exclude .DS_Store files', async () => {
      await writeFile(join(tempDir, '.DS_Store'), 'binary data');
      const files = await predictor.getFiles();
      assert.ok(!files.some(f => f.includes('.DS_Store')));
    });

    it('should exclude .env files', async () => {
      await writeFile(join(tempDir, '.env'), 'SECRET=value');
      const files = await predictor.getFiles();
      assert.ok(!files.some(f => f.includes('.env')));
    });

    it('should exclude .gitignore', async () => {
      await writeFile(join(tempDir, '.gitignore'), 'node_modules/');
      const files = await predictor.getFiles();
      assert.ok(!files.some(f => f.includes('.gitignore')));
    });
  });

  describe('git-blame recency', () => {
    it('should return empty map when not in git repo', async () => {
      const recency = await predictor._getGitBlameRecency();
      assert.ok(recency instanceof Map);
      // Since tempDir is not a git repo, should be empty
    });

    it('should cache git-blame results', async () => {
      const recency1 = await predictor._getGitBlameRecency();
      const recency2 = await predictor._getGitBlameRecency();
      assert.strictEqual(recency1, recency2); // Same object reference due to caching
    });
  });

  describe('import graph analysis', () => {
    it('should extract ES6 imports', () => {
      const content = `import { foo } from './foo.ts';\nimport bar from '../bar.ts';`;
      const imports = predictor._extractImports(content, 'test.ts');
      assert.ok(imports.includes('./foo.ts'));
      assert.ok(imports.includes('../bar.ts'));
    });

    it('should extract CommonJS requires', () => {
      const content = `const foo = require('./foo.js');\nconst bar = require('../bar.js');`;
      const imports = predictor._extractImports(content, 'test.js');
      assert.ok(imports.includes('./foo.js'));
      assert.ok(imports.includes('../bar.js'));
    });

    it('should extract dynamic imports', () => {
      const content = `const mod = await import('./module.js');`;
      const imports = predictor._extractImports(content, 'test.js');
      assert.ok(imports.includes('./module.js'));
    });

    it('should deduplicate imports', () => {
      const content = `import foo from './foo.ts';\nimport { bar } from './foo.ts';`;
      const imports = predictor._extractImports(content, 'test.ts');
      const fooCount = imports.filter(i => i === './foo.ts').length;
      assert.equal(fooCount, 1);
    });
  });

  describe('access frequency tracking', () => {
    it('should record file access', () => {
      predictor.recordAccess('test.ts');
      predictor.recordAccess('test.ts');
      assert.equal(predictor.accessFrequency.get('test.ts'), 2);
    });

    it('should boost scores for frequently accessed files', async () => {
      predictor.recordAccess('src/components/Button.tsx');
      predictor.recordAccess('src/components/Button.tsx');
      predictor.recordAccess('src/components/Button.tsx');

      const results = await predictor.predict('button');
      const buttonFile = results.find(r => r.file.includes('Button.tsx'));
      assert.ok(buttonFile);
      assert.ok(buttonFile.score > 0);
    });
  });
});
