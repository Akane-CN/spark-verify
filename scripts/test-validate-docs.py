#!/usr/bin/env python3
"""Regression tests for the Spark Verify documentation validator."""

from __future__ import annotations

import importlib.util
import json
import copy
import tempfile
import unittest
from unittest.mock import patch as mock_patch
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

    def validate_report(self, report: dict) -> list[str]:
        result = VALIDATOR.Validation()
        VALIDATOR.validate_report_example(result, VALIDATOR_PATH, 1, report)
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

    def test_rejected_manifest_requires_supported_debugger(self) -> None:
        manifest = {
            "meta": {"name": "x", "spec": "0.1.0-draft.3"},
            "toolchain": {"ckb": "0.209.0", "offckb": "0.4.13"},
            "replay": {"dependencies": []}, "setup": {"accounts": 2},
            "step": [{"name": "bad", "run": "trusted-producer", "expect": {"tx": "rejected"}}],
        }
        self.assert_error(self.validate_manifest(manifest), "requires ckb-debugger 1.1.1")
        manifest["toolchain"]["ckb-debugger"] = "1.1.2"
        self.assert_error(self.validate_manifest(manifest), "requires ckb-debugger 1.1.1")
        manifest["toolchain"]["ckb-debugger"] = "1.1.1"
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

    def test_optional_debugger_pin_must_be_supported_even_without_rejection(self) -> None:
        manifest = {
            "meta": {"name": "x", "spec": "0.1.0-draft.3"},
            "toolchain": {"ckb": "0.209.0", "offckb": "0.4.13", "ckb-debugger": "1.1.2"},
            "replay": {"dependencies": []}, "setup": {"accounts": 2},
            "step": [{"name": "transfer", "run": "trusted-producer", "expect": {"tx": "committed"}}],
        }
        self.assert_error(self.validate_manifest(manifest), "ckb-debugger must select supported pin 1.1.1")
        manifest["toolchain"]["ckb-debugger"] = "1.1.1"
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
        with tempfile.TemporaryDirectory() as directory, mock_patch.object(VALIDATOR, "ROOT", Path(directory)):
            path = Path(directory) / "report.md"
            path.write_text(report, encoding="utf-8")
            result = VALIDATOR.Validation()
            VALIDATOR.validate_markdown(result, path, set())
        self.assert_error(result.errors, "replay.declared_dependencies")

    def test_current_report_requires_the_implemented_top_level_contract(self) -> None:
        report = """```json
{"schema":"ckb-verify-report/1","verdict":"PASS","digests":{"outcome":"sha256:0000000000000000000000000000000000000000000000000000000000000000","environment":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}}
```
"""
        with tempfile.TemporaryDirectory() as directory, mock_patch.object(VALIDATOR, "ROOT", Path(directory)):
            path = Path(directory) / "report.md"
            path.write_text(report, encoding="utf-8")
            result = VALIDATOR.Validation()
            VALIDATOR.validate_markdown(result, path, set())
        self.assert_error(result.errors, "current report requires top-level fields")

    def test_current_and_explicit_historical_report_policy(self) -> None:
        historical = json.loads((VALIDATOR.ROOT / "docs/examples/secp-transfer-committed-report.json").read_text())
        current = copy.deepcopy(historical)
        current["environment"]["schema"] = "ckb-verify-environment/3"
        current["environment"]["provenance"]["schema"] = "ckb-verify-provenance/2"
        current["environment"]["provenance"]["binaries"]["ckbDebugger"] = None
        self.assertEqual(self.validate_report(current), [])
        self.assertTrue(self.validate_report(historical))
        result = VALIDATOR.Validation()
        VALIDATOR.validate_report_example(result, VALIDATOR_PATH, 1, historical, allow_legacy=True)
        self.assertEqual(result.errors, [])
        for env, prov in [("3", "1"), ("2", "2"), ("4", "2"), ("3", "3")]:
            bad = copy.deepcopy(current)
            bad["environment"]["schema"] = "ckb-verify-environment/" + env
            bad["environment"]["provenance"]["schema"] = "ckb-verify-provenance/" + prov
            for allow in [False, True]:
                result = VALIDATOR.Validation()
                VALIDATOR.validate_report_example(result, VALIDATOR_PATH, 1, bad, allow_legacy=allow)
                self.assertTrue(result.errors)
        missing = copy.deepcopy(current)
        del missing["environment"]["provenance"]["binaries"]["ckbDebugger"]
        self.assertTrue(self.validate_report(missing))
        contradiction = copy.deepcopy(current)
        contradiction["environment"]["toolchain"]["requested"]["ckbDebugger"] = "1.1.1"
        self.assertTrue(self.validate_report(contradiction))
        pinned = copy.deepcopy(current)
        pin = json.loads((VALIDATOR.ROOT / "schemas/ckb-verify-provenance-v2.schema.json").read_text())["$defs"]["ckbDebuggerBinary"]["const"]
        pinned["environment"]["provenance"]["binaries"]["ckbDebugger"] = pin
        pinned["environment"]["toolchain"]["requested"]["ckbDebugger"] = "1.1.1"
        pinned["environment"]["toolchain"]["observed"]["ckbDebugger"] = "ckb-debugger 1.1.1"
        self.assertEqual(self.validate_report(pinned), [])
        wrong_platform = copy.deepcopy(pinned)
        wrong_platform["environment"]["platform"]["arch"] = "arm64"
        self.assertTrue(self.validate_report(wrong_platform))
        pinned["environment"]["provenance"]["binaries"]["ckbDebugger"]["archive"]["observed"]["bytes"] -= 1
        self.assertTrue(self.validate_report(pinned))

    def test_current_report_accepts_the_implemented_envelope(self) -> None:
        digest = "sha256:" + ("0" * 64)
        report = {
            "schema": "ckb-verify-report/1",
            "verdict": "PASS",
            "createdAt": "2026-09-08T00:00:00.000Z",
            "evidence": {},
            "outcomeClaims": {"schema": "ckb-verify-outcome/1"},
            "environment": {
                "schema": "ckb-verify-environment/3",
                "runner": {},
                "toolchain": {"requested": {}, "observed": {}},
                "provenance": {
                    "schema": "ckb-verify-provenance/2",
                    "binaries": {"ckbDebugger": None},
                    "replay": {"declaredDependencies": [], "status": "stable", "reasons": []},
                },
                "platform": {},
                "devnet": {},
            },
            "digests": {"outcome": digest, "environment": digest},
        }
        self.assertEqual(self.validate_report(report), [])

    def test_current_report_rejects_invalid_nested_contracts(self) -> None:
        report = {
            "schema": "ckb-verify-report/1",
            "verdict": "ERROR",
            "createdAt": "",
            "evidence": [],
            "outcomeClaims": {"schema": "spark-verify-outcome/0"},
            "environment": {"schema": "spark-verify-environment/0"},
            "digests": {"outcome": "not-a-digest", "environment": "also-invalid"},
        }
        errors = self.validate_report(report)
        for message in (
            "verdict must be PASS or FAIL",
            "requires createdAt",
            "requires evidence",
            "requires ckb-verify-outcome/1",
            "requires ckb-verify-environment/3",
            "digest must be canonical sha256",
        ):
            self.assert_error(errors, message)


if __name__ == "__main__":
    unittest.main()
