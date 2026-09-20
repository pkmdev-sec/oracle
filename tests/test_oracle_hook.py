#!/usr/bin/env python3
"""Contract tests for the Oracle UserPromptSubmit hook."""

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


HOOK_PATH = Path(__file__).parents[1] / "hooks" / "oracle-preload.py"
SPEC = importlib.util.spec_from_file_location("oracle_preload", HOOK_PATH)
oracle_preload = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oracle_preload)


class OracleHookContractTest(unittest.TestCase):
    def test_emits_user_prompt_submit_additional_context(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = Path(temp_dir)
            (project / "README.md").write_text("# Example\nSafe project context.\n")
            oracle_preload.DATA_DIR = project / ".oracle-data"

            hook_input = {
                "prompt": "update the README documentation",
                "cwd": str(project),
            }
            stdout = io.StringIO()

            with contextlib.redirect_stdout(stdout):
                original_stdin = sys.stdin
                try:
                    sys.stdin = io.StringIO(json.dumps(hook_input))
                    oracle_preload.main()
                finally:
                    sys.stdin = original_stdin

            result = json.loads(stdout.getvalue())
            hook_output = result["hookSpecificOutput"]
            self.assertEqual(hook_output["hookEventName"], "UserPromptSubmit")
            self.assertIn("README.md", hook_output["additionalContext"])
            self.assertLessEqual(len(hook_output["additionalContext"]), 10_000)


if __name__ == "__main__":
    unittest.main()
