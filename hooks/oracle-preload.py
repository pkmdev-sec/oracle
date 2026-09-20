#!/usr/bin/env python3
"""
ORACLE — UserPromptSubmit Hook
Intercepts user prompts, predicts needed context, and injects it.

Hook Type: UserPromptSubmit
Install: Add to .claude/settings.json hooks.UserPromptSubmit
"""

import json
import os
import sys
import subprocess
import hashlib
from pathlib import Path

# ─── Configuration ──────────────────────────────────────────
DATA_DIR = Path(os.environ.get("ORACLE_DATA_DIR", Path.home() / ".oracle"))
MAX_CONTEXT_CHARS = 8_000
MAX_FILES = 10
ENABLED = os.environ.get("ORACLE_ENABLED", "1") == "1"

# ─── Keyword Patterns ──────────────────────────────────────
KEYWORD_PATTERNS = {
    "test":      ["tests/", "test/", "__tests__/", ".test.", ".spec."],
    "config":    [".config.", ".env", "settings.", "config/"],
    "api":       ["api/", "routes/", "endpoints/", "controllers/"],
    "model":     ["models/", "schema/", "entities/", "types/"],
    "component": ["components/", "views/", "pages/"],
    "hook":      ["hooks/", ".claude/hooks/"],
    "style":     ["styles/", ".css", ".scss"],
    "util":      ["utils/", "helpers/", "lib/"],
    "auth":      ["auth/", "middleware/auth", "login", "session"],
    "database":  ["db/", "database/", "prisma/", "migration"],
}

STOP_WORDS = {
    "the", "and", "for", "this", "that", "with", "from", "are", "was",
    "will", "can", "has", "have", "been", "not", "but", "all", "any",
    "you", "your", "how", "what", "when", "please", "help", "want",
    "need", "just", "make", "sure", "like", "use", "also",
}


def extract_keywords(prompt: str) -> list[str]:
    """Extract meaningful keywords from prompt."""
    import re
    words = re.findall(r"[a-z][a-z0-9_.-]+", prompt.lower())
    return list(set(w for w in words if len(w) > 2 and w not in STOP_WORDS))


def extract_explicit_paths(prompt: str) -> list[str]:
    """Extract file paths mentioned in the prompt."""
    import re
    pattern = r"(?:^|\s|[\"'`(])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,6})(?:[\"'`)\s]|$)"
    return [m.group(1) for m in re.finditer(pattern, prompt)]


def scan_project_files(root: Path, max_depth: int = 6) -> list[str]:
    """Recursively scan for relevant source files."""
    skip_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
    code_exts = {
        ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
        ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
        ".json", ".yaml", ".yml", ".toml", ".md", ".sh",
        ".css", ".scss", ".html", ".vue", ".svelte",
    }
    files = []

    def _scan(directory: Path, depth: int):
        if depth > max_depth:
            return
        try:
            for entry in directory.iterdir():
                if entry.name.startswith(".") and entry.name != ".claude":
                    continue
                if entry.name in skip_dirs:
                    continue
                if entry.is_dir():
                    _scan(entry, depth + 1)
                elif entry.is_file() and entry.suffix in code_exts:
                    files.append(str(entry.relative_to(root)))
        except PermissionError:
            pass

    _scan(root, 0)
    return files


def score_file(filepath: str, keywords: list[str]) -> float:
    """Score a file based on keyword matches."""
    score = 0.0
    lower_path = filepath.lower()
    filename = os.path.basename(filepath).lower()

    for kw in keywords:
        if kw in filename:
            score += 10
        elif kw in lower_path:
            score += 5

        for pattern_key, patterns in KEYWORD_PATTERNS.items():
            if kw in pattern_key or pattern_key in kw:
                for pat in patterns:
                    if pat.lower() in lower_path:
                        score += 3
                        break
    return score


def predict_files(prompt: str, project_root: Path) -> list[dict]:
    """Predict which files are needed for the prompt."""
    keywords = extract_keywords(prompt)
    explicit_paths = extract_explicit_paths(prompt)
    files = scan_project_files(project_root)

    scored = []
    for f in files:
        s = score_file(f, keywords)

        # Explicit path mentions get max boost
        for ep in explicit_paths:
            if ep in f or f.endswith(ep):
                s += 50

        if s > 0:
            scored.append({"file": f, "score": s})

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:MAX_FILES]


def load_file_content(project_root: Path, filepath: str, max_size: int = 100_000) -> str | None:
    """Load file content if within size limit."""
    full_path = project_root / filepath
    try:
        if full_path.stat().st_size > max_size:
            return None
        return full_path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return None


def build_context(predictions: list[dict], project_root: Path) -> str:
    """Build injectable context string from predictions."""
    parts = []
    total_size = 0

    for pred in predictions:
        content = load_file_content(project_root, pred["file"])
        if content is None:
            continue
        part = f"--- {pred['file']} (score: {pred['score']:.1f}) ---\n{content}"
        if total_size + len(part) > MAX_CONTEXT_CHARS:
            continue
        parts.append(part)
        total_size += len(part)

    return "\n\n".join(parts)


def load_learned_patterns(data_dir: Path) -> dict:
    """Load learned keyword→file patterns from disk."""
    patterns_file = data_dir / "patterns.json"
    try:
        data = json.loads(patterns_file.read_text())
        return data.get("keywordFileMap", {})
    except (OSError, json.JSONDecodeError):
        return {}


def get_learned_suggestions(prompt: str, data_dir: Path) -> list[dict]:
    """Get file suggestions from learned patterns."""
    keyword_file_map = load_learned_patterns(data_dir)
    if not keyword_file_map:
        return []

    keywords = extract_keywords(prompt)
    file_scores: dict[str, float] = {}

    for kw in keywords:
        file_map = keyword_file_map.get(kw, {})
        for filepath, count in file_map.items():
            file_scores[filepath] = file_scores.get(filepath, 0) + count

    return [
        {"file": f, "score": s * 2}
        for f, s in sorted(file_scores.items(), key=lambda x: x[1], reverse=True)[:MAX_FILES]
    ]


def main():
    """Main hook entry point — reads from stdin, outputs to stdout."""
    if not ENABLED:
        sys.exit(0)

    # Read hook input from stdin
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    prompt = hook_input.get("prompt", "")
    if not prompt or len(prompt) < 5:
        sys.exit(0)

    # Determine project root (cwd of the session)
    project_root = Path(hook_input.get("cwd", os.getcwd()))
    if not project_root.exists():
        sys.exit(0)

    # Predict files
    predictions = predict_files(prompt, project_root)

    # Merge with learned suggestions
    learned = get_learned_suggestions(prompt, DATA_DIR)
    seen = {p["file"] for p in predictions}
    for l in learned:
        if l["file"] not in seen:
            predictions.append(l)

    if not predictions:
        sys.exit(0)

    # Build context
    context = build_context(predictions, project_root)
    if not context:
        sys.exit(0)

    file_list = ", ".join(p["file"] for p in predictions[:5])[:500]

    additional_context = (
        f"[ORACLE] Predicted context ({len(predictions)} files: {file_list}):\n"
        f"<oracle-context>\n{context}\n</oracle-context>\n"
    )

    result = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": additional_context,
        }
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
