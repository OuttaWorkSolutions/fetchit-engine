"""fetchit-engine: deterministic text cleanup and AI-writing heuristics.

Public API mirrors @fetchit/engine (JavaScript). See core.py for the
CleanResult contract; parity is enforced by packages/engine-core/vectors.json.
"""
from .core import (
    ENGINE_VERSION,
    RULESET_VERSION,
    MIN_CHARS,
    MIN_WORDS,
    clean,
    rebuild_text,
    remove_em_dashes,
    apply_edits,
    find_ai_spans,
    analyze_ai_signals,
)

__all__ = [
    "ENGINE_VERSION",
    "RULESET_VERSION",
    "MIN_CHARS",
    "MIN_WORDS",
    "clean",
    "rebuild_text",
    "remove_em_dashes",
    "apply_edits",
    "find_ai_spans",
    "analyze_ai_signals",
]
__version__ = ENGINE_VERSION
