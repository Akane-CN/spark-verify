#!/usr/bin/env python3
"""Regression tests for the Spark Verify documentation validator."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

VALIDATOR_PATH = Path(__file__).with_name("validate-docs.py")
SPEC = importlib.util.spec_from_file_location("spark_verify_validate_docs", VALIDATOR_PATH)
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class ValidatorTests(unittest.TestCase):
    def validate_cell(self, assertion: dict) -> list[str]:
        result = VALIDATOR.Validation()
        VALIDATOR.validate_cell(result, VALIDATOR_PATH, 1, assertion)
        return result.errors

    def validate_expect(self, expect: dict) -> list[str]:
        result = VALIDATOR.Validation()
        VALIDATOR.validate_expect(result, VALIDATOR_PATH, 1, expect)
        return result.errors

    def validate_manifest(self, manifest: dict) -> list[str]:
        result = VALIDATOR.Validation()
        VALIDATOR.validate_toml_semantics(result, VALIDATOR_PATH, 1, manifest)
        return result.errors

    def assert_error(self, errors: list[str], text: str) -> None:
        self.assertTrue(any(text in error for error in errors), errors)

    def test_count_rejects_string(self) -> None:
        errors = self.validate_cell({"lock": "x", "count": "1"})
        self.assert_error(errors, "Cell count must be")

    def test_count_lte_zero_is_not_exact_absence_syntax(self) -> None:
        errors = self.validate_cell({"lock": "x", "count": {"lte": 0}})
        self.assert_error(errors, "assert absence with count = 0")

    def test_properties_reject_zero_upper_bound(self) -> None:
        errors = self.validate_cell({"lock": "x", "count": {"lte": 0}, "data": {"len": 1}})
        self.assert_error(errors, "effective count.gte = 1")

    def test_properties_reject_exact_zero(self) -> None:
        errors = self.validate_cell({"lock": "x", "count": {"eq": 0}, "capacity": {"gte": "1 CKB"}})
        self.assert_error(errors, "exact zero count cannot coexist")

    def test_uploaded_tx_vocabulary_is_accepted(self) -> None:
        self.assertEqual(self.validate_expect({"tx": "committed", "cycles": {"lt": 5_000_000}}), [])

    def test_legacy_status_vocabulary_is_rejected(self) -> None:
        errors = self.validate_expect({"status": "committed"})
        self.assert_error(errors, "unsupported step.expect keys")

    def test_error_requires_rejected_tx(self) -> None:
        errors = self.validate_expect({"tx": "committed", "error": {"code": -1}})
        self.assert_error(errors, "expect.error requires expect.tx = rejected")

    def test_full_manifest_requires_replay_declaration(self) -> None:
        manifest = {
            "meta": {"name": "x", "spec": "0.1.0-draft.3"},
            "toolchain": {"ckb": "0.209.0", "offckb": "0.4.13", "ckb-debugger": "1.1.1"},
            "setup": {"accounts": 0},
        }
        errors = self.validate_manifest(manifest)
        self.assert_error(errors, "requires [replay].dependencies")

    def test_full_manifest_accepts_explicit_empty_replay_declaration(self) -> None:
        manifest = {
            "meta": {"name": "x", "spec": "0.1.0-draft.3"},
            "toolchain": {"ckb": "0.209.0", "offckb": "0.4.13"},
            "replay": {"dependencies": []},
            "setup": {"accounts": 0},
            "assert": {"balance": [{"account": 0, "gte": "0 CKB"}]},
        }
        self.assertEqual(self.validate_manifest(manifest), [])

    def test_full_manifest_accepts_optional_debugger_version(self) -> None:
        manifest = {
            "meta": {"name": "x", "spec": "0.1.0-draft.3"},
            "toolchain": {
                "ckb": "0.209.0",
                "offckb": "0.4.13",
                "ckb-debugger": "1.1.1",
            },
            "replay": {"dependencies": []},
            "setup": {"accounts": 0},
            "assert": {"balance": [{"account": 0, "gte": "0 CKB"}]},
        }
        self.assertEqual(self.validate_manifest(manifest), [])

    def test_full_manifest_rejects_empty_claim_set(self) -> None:
        manifest = {
            "meta": {"name": "x", "spec": "0.1.0-draft.3"},
            "toolchain": {"ckb": "0.209.0", "offckb": "0.4.13", "ckb-debugger": "1.1.1"},
            "replay": {"dependencies": []},
            "setup": {"accounts": 0},
        }
        errors = self.validate_manifest(manifest)
        self.assert_error(errors, "requires at least one expectation or assertion")

    def test_replay_dependencies_reject_duplicates_and_unknown_values(self) -> None:
        result = VALIDATOR.Validation()
        VALIDATOR.validate_replay(
            result,
            VALIDATOR_PATH,
            1,
            {"dependencies": ["randomness", "randomness", "unknown"]},
            required=True,
        )
        self.assert_error(result.errors, "must be unique")
        self.assert_error(result.errors, "unsupported replay dependency")

    def test_report_requires_declared_dependencies(self) -> None:
        report = """```json
{"schema":"spark-verify-report/0.1-draft.3","digests":{"outcome":"x","environment":"y"},"replay":{"status":"stable","reasons":[]}}
```
"""
        with tempfile.TemporaryDirectory(dir=VALIDATOR.ROOT) as directory:
            path = Path(directory) / "report.md"
            path.write_text(report, encoding="utf-8")
            result = VALIDATOR.Validation()
            VALIDATOR.validate_markdown(result, path, set())
        self.assert_error(result.errors, "replay.declared_dependencies")


if __name__ == "__main__":
    unittest.main()
