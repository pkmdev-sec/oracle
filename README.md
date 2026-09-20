![Oracle banner](assets/banner.svg)

# Oracle

[![CI](https://github.com/pkmdev-sec/oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/pkmdev-sec/oracle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)

Oracle predicts which project files may help with a prompt. Its JavaScript library ranks files, preloads their contents, and learns from feedback. Its optional Claude Code hook injects predicted file content through the `UserPromptSubmit` `additionalContext` field.

## Install

```bash
git clone https://github.com/pkmdev-sec/oracle.git
cd oracle
npm test
```

Requirements:

- Node.js 18 or newer
- Python 3.10 or newer for the optional hook

Oracle has no npm dependencies.

## Use the JavaScript API

```javascript
import { Oracle } from '@pkmdev-sec/oracle';

const oracle = new Oracle({ rootDir: '/path/to/project' });
await oracle.init();

const prediction = await oracle.predictContext(
  'Fix the authentication middleware'
);

console.log(prediction.files);
console.log(prediction.stats);

await oracle.recordFeedback(
  'Fix the authentication middleware',
  prediction.files.map((item) => item.file),
  ['src/middleware/auth.ts', 'src/config/auth.json']
);
```

### Main modules

| Module | Purpose |
|---|---|
| [`file-predictor.mjs`](lib/file-predictor.mjs) | Scores files from prompt keywords, paths, history, and co-occurrence |
| [`context-ranker.mjs`](lib/context-ranker.mjs) | Ranks predictions using score, recency, frequency, proximity, and file type |
| [`preloader.mjs`](lib/preloader.mjs) | Loads files into an in-memory LRU cache |
| [`pattern-learner.mjs`](lib/pattern-learner.mjs) | Stores feedback and learns keyword-to-file associations |
| [`index.mjs`](lib/index.mjs) | Runs the prediction, ranking, preload, and feedback flow |

## Configure the Claude Code hook

Add the hook explicitly to your Claude Code settings. Replace the command path with the absolute path to your clone.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 /absolute/path/to/oracle/hooks/oracle-preload.py"
          }
        ]
      }
    ]
  }
}
```

The hook reads the submitted prompt and the session working directory. It scans supported source and documentation files, selects up to ten matches, and returns no more than 10,000 characters through Claude Code's `additionalContext` contract.

Configure hook behavior with:

| Variable | Default | Purpose |
|---|---|---|
| `ORACLE_ENABLED` | `1` | Set to `0` to disable the hook |
| `ORACLE_DATA_DIR` | `~/.oracle` | Directory containing `patterns.json` |

## Security and limits

Oracle sends selected file contents to the active model as context. Use the hook only in repositories whose contents may be sent to that model provider. Review generated files, credentials, private keys, and local configuration before enabling it.

Prediction is heuristic. A selected file may be irrelevant, and an important file may be missed. Oracle does not replace repository search, tests, or human review.

The Python hook and JavaScript library are separate implementations. The hook reads learned patterns from `ORACLE_DATA_DIR`; set that variable to the directory containing the pattern data you want it to use.

## Examples

```bash
node examples/predict-context.mjs
node examples/preload-demo.mjs
```

## Documentation

- [Architecture](docs/architecture.md)
- [Data-flow diagrams](docs/diagrams.md)

## Test

```bash
npm test
```

The test command runs the JavaScript suite and the Python hook contract test. CI runs it on Node.js 18, 20, and 22.

## License

[MIT](LICENSE) © pkmdev-sec
