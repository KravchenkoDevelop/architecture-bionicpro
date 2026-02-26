"""
conftest.py — pytest fixtures and hooks for BionicPRO Reports Service tests.

After all tests complete, writes a human-readable summary to:
    reports-service/test_results.txt
"""

from __future__ import annotations

import sys
import os
from datetime import datetime
from pathlib import Path

import pytest

# Make the reports-service package importable from tests/
sys.path.insert(0, str(Path(__file__).parent.parent))

# ---------------------------------------------------------------------------
# Result collection via pytest hooks
# ---------------------------------------------------------------------------

_results: list[dict] = []


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Intercept each test result and store it for the final report."""
    outcome = yield
    rep = outcome.get_result()

    if rep.when == "call":
        _results.append({
            "nodeid":   item.nodeid,
            "status":   rep.outcome,          # "passed" | "failed" | "error"
            "duration": rep.duration,
            "longrepr": str(rep.longrepr).strip() if rep.longrepr else "",
        })


def pytest_sessionfinish(session, exitstatus):
    """Write results to test_results.txt after the session ends."""
    out_path = Path(__file__).parent.parent / "test_results.txt"

    passed = sum(1 for r in _results if r["status"] == "passed")
    failed = sum(1 for r in _results if r["status"] == "failed")
    total  = len(_results)

    lines = [
        "=" * 72,
        "BionicPRO Reports Service — Automated Test Results",
        f"Run at : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Suite  : reports-service/tests/",
        "=" * 72,
        "",
        "Tested requirements:",
        "  [1] UI can call GET /reports to fetch the report",
        "  [2] Unauthenticated requests are rejected (HTTP 401)",
        "  [3] Users can only access their own report (user_id from JWT)",
        "  [4] Service reads from OLAP DB — no real-time aggregation",
        "  [5] 404 returned when Airflow has not yet processed the period",
        "",
        "Results:",
        "-" * 72,
    ]

    for r in _results:
        mark   = "✓ PASS" if r["status"] == "passed" else "✗ FAIL"
        # Strip the test file prefix for readability
        short  = r["nodeid"].split("::")[-1] if "::" in r["nodeid"] else r["nodeid"]
        lines.append(f"  {mark}  [{r['duration']:.3f}s]  {short}")
        if r["longrepr"]:
            for line in r["longrepr"].split("\n")[:8]:
                lines.append(f"            {line}")

    verdict = "ALL TESTS PASSED ✓" if failed == 0 else f"{failed} TEST(S) FAILED ✗"
    lines += [
        "",
        "=" * 72,
        f"  Total: {total}  |  Passed: {passed}  |  Failed: {failed}",
        f"  Verdict: {verdict}",
        "=" * 72,
        "",
    ]

    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n  📄  Results saved → {out_path}")
