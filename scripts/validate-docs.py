#!/usr/bin/env python3
"""Validate Spark Verify documentation and embedded examples."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_HASH_TYPES = {"type", "data", "data1", "data2"}
ALLOWED_REPLAY_DEPENDENCIES = {
    "dynamic_since",
    "external_network",
    "external_time",
    "fee_estimation",
    "randomness",
}
COMPARATORS = {"eq", "gte", "lte"}
VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){1,2}(?:[-+][0-9A-Za-z.-]+)?$")
CKB_AMOUNT_RE = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})? CKB$|^(?:0|[1-9][0-9]*) shannon$")
TOKEN_AMOUNT_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")
HEX_RE = re.compile(r"^0x(?:[0-9a-fA-F]{2})*$")
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
FENCE_RE = re.compile(r"```(?P<lang>toml|json)\n(?P<body>.*?)\n```", re.DOTALL)
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
SECRET_PATTERNS = {
    "GitHub token": re.compile(r"(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}"),
    "API key": re.compile(r"\bsk-[A-Za-z0-9]{20,}"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
}
IGNORED_PARTS = {".bun", ".ckb-verify", ".git", "coverage", "dist", "node_modules"}


class Validation:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.toml_count = 0
        self.json_count = 0

    def error(self, file: Path, line: int, message: str) -> None:
        self.errors.append(f"{file.relative_to(ROOT)}:{line}: {message}")


def walk(value: Any) -> Iterable[Any]:
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def validate_amounts(v: Validation, file: Path, line: int, assertion: dict[str, Any]) -> None:
    targets = [key for key in ("account", "address", "lock") if key in assertion]
    if len(targets) != 1:
        v.error(file, line, "balance assertion requires exactly one of account/address/lock")
    comparators = [key for key in ("eq", "gte", "lte") if key in assertion]
    if not comparators:
        v.error(file, line, "balance assertion requires eq, gte, or lte")
    if "eq" in comparators and len(comparators) > 1:
        v.error(file, line, "balance.eq cannot coexist with another balance comparator")
    amount_pattern = TOKEN_AMOUNT_RE if "udt" in assertion else CKB_AMOUNT_RE
    for comparator in comparators:
        amount = assertion[comparator]
        if not isinstance(amount, str) or not amount_pattern.fullmatch(amount):
            mode = "token base-unit" if "udt" in assertion else "CKB/shannon"
            v.error(file, line, f"balance.{comparator} must be a canonical {mode} quantity string")


def validate_cell(v: Validation, file: Path, line: int, assertion: dict[str, Any]) -> None:
    count = assertion.get("count")
    has_properties = "data" in assertion or "capacity" in assertion
    exact_zero = (
        isinstance(count, int)
        and not isinstance(count, bool)
        and count == 0
    ) or (
        isinstance(count, dict)
        and isinstance(count.get("eq"), int)
        and not isinstance(count.get("eq"), bool)
        and count.get("eq") == 0
    )
    if exact_zero and has_properties:
        v.error(file, line, "exact zero count cannot coexist with per-Cell data/capacity checks")
    if isinstance(count, bool):
        v.error(file, line, "Cell count must be a non-negative integer or comparator table")
    elif isinstance(count, int):
        if count < 0:
            v.error(file, line, "Cell count cannot be negative")
    elif isinstance(count, dict):
        if not count:
            v.error(file, line, "Cell count comparator table cannot be empty")
        for comparator, value in count.items():
            if comparator not in COMPARATORS:
                v.error(file, line, f"unsupported count comparator {comparator!r}")
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                v.error(file, line, f"count.{comparator} must be a non-negative integer")
        if "eq" in count and len(count) > 1:
            v.error(file, line, "count.eq cannot coexist with another count comparator")
        gte, lte = count.get("gte"), count.get("lte")
        if (
            isinstance(gte, int)
            and not isinstance(gte, bool)
            and isinstance(lte, int)
            and not isinstance(lte, bool)
            and gte > lte
        ):
            v.error(file, line, "count.gte cannot exceed count.lte")
        if lte == 0 and count.get("eq") != 0:
            v.error(file, line, "assert absence with count = 0 or count.eq = 0, not count.lte = 0")
        if has_properties and isinstance(lte, int) and not isinstance(lte, bool) and lte < 1:
            v.error(file, line, "per-Cell properties require an effective count.gte = 1")
    elif count is not None:
        v.error(file, line, "Cell count must be a non-negative integer or comparator table")
    if not any(key in assertion for key in ("out_point", "lock", "type")):
        v.error(file, line, "Cell assertion requires out_point, lock, or type")
    if not any(key in assertion for key in ("count", "data", "capacity")):
        v.error(file, line, "Cell assertion requires a count, data, or capacity check")

    data = assertion.get("data")
    if data is not None:
        if not isinstance(data, dict) or not data:
            v.error(file, line, "data must be a non-empty comparator table")
        else:
            if set(data) - {"eq", "len"}:
                v.error(file, line, f"unsupported data keys {sorted(set(data) - {'eq', 'len'})}")
            if "eq" in data and (not isinstance(data["eq"], str) or not HEX_RE.fullmatch(data["eq"])):
                v.error(file, line, "data.eq must be even-length 0x-prefixed hex")
            if "len" in data and (isinstance(data["len"], bool) or not isinstance(data["len"], int) or data["len"] < 0):
                v.error(file, line, "data.len must be a non-negative integer")

    capacity = assertion.get("capacity")
    if capacity is not None:
        if not isinstance(capacity, dict) or not capacity:
            v.error(file, line, "capacity must be a non-empty comparator table")
        else:
            if set(capacity) - {"eq", "gte", "lte"}:
                v.error(file, line, f"unsupported capacity keys {sorted(set(capacity) - {'eq', 'gte', 'lte'})}")
            if "eq" in capacity and len(capacity) > 1:
                v.error(file, line, "capacity.eq cannot coexist with another capacity comparator")
            for comparator, amount in capacity.items():
                if not isinstance(amount, str) or not CKB_AMOUNT_RE.fullmatch(amount):
                    v.error(file, line, f"capacity.{comparator} must be a canonical CKB/shannon quantity string")


def validate_assertions(v: Validation, file: Path, line: int, table: Any) -> None:
    if not isinstance(table, dict):
        return
    for kind, validator in (("cell", validate_cell), ("balance", validate_amounts)):
        items = table.get(kind, [])
        if not isinstance(items, list):
            v.error(file, line, f"assert.{kind} must be an array of tables")
            continue
        for item in items:
            if not isinstance(item, dict):
                v.error(file, line, f"assert.{kind} entries must be tables")
                continue
            validator(v, file, line, item)


def validate_output_references(
    v: Validation,
    file: Path,
    line: int,
    table: Any,
    allowed_steps: set[str],
) -> None:
    if not isinstance(table, dict):
        return
    items = table.get("cell", [])
    if not isinstance(items, list):
        return
    for item in items:
        out_point = item.get("out_point") if isinstance(item, dict) else None
        if out_point is None:
            continue
        if not isinstance(out_point, dict) or set(out_point) != {"step", "index"}:
            v.error(file, line, "out_point must contain exactly step and index")
            continue
        step_name, index = out_point["step"], out_point["index"]
        if not isinstance(step_name, str) or step_name not in allowed_steps:
            v.error(file, line, f"out_point references unknown or future step {step_name!r}")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            v.error(file, line, "out_point.index must be a non-negative integer")


def validate_replay(v: Validation, file: Path, line: int, replay: Any, *, required: bool) -> None:
    if replay is None:
        if required:
            v.error(file, line, "a full manifest requires [replay].dependencies")
        return
    if not isinstance(replay, dict):
        v.error(file, line, "replay must be a table")
        return
    if set(replay) != {"dependencies"}:
        v.error(file, line, "replay must contain exactly dependencies")
    dependencies = replay.get("dependencies")
    if not isinstance(dependencies, list):
        v.error(file, line, "replay.dependencies must be an array")
        return
    if all(isinstance(item, str) for item in dependencies) and len(dependencies) != len(set(dependencies)):
        v.error(file, line, "replay.dependencies values must be unique")
    for dependency in dependencies:
        if not isinstance(dependency, str) or dependency not in ALLOWED_REPLAY_DEPENDENCIES:
            v.error(file, line, f"unsupported replay dependency {dependency!r}")


def validate_expect(v: Validation, file: Path, line: int, expect: Any) -> None:
    if expect is None:
        return
    if not isinstance(expect, dict) or not expect:
        v.error(file, line, "step.expect must be a non-empty table")
        return
    allowed = {"tx", "cycles", "error"}
    unknown = set(expect) - allowed
    if unknown:
        v.error(file, line, f"unsupported step.expect keys {sorted(unknown)}")
    tx = expect.get("tx")
    if tx not in {"committed", "rejected"}:
        v.error(file, line, "step.expect.tx must be committed or rejected")
    cycles = expect.get("cycles")
    if cycles is not None:
        if not isinstance(cycles, dict) or not cycles:
            v.error(file, line, "expect.cycles must be a non-empty comparator table")
        else:
            allowed_cycles = COMPARATORS | {"lt"}
            if set(cycles) - allowed_cycles:
                v.error(file, line, f"unsupported cycles comparators {sorted(set(cycles) - allowed_cycles)}")
            if "eq" in cycles and len(cycles) > 1:
                v.error(file, line, "cycles.eq cannot coexist with another comparator")
            for comparator, value in cycles.items():
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    v.error(file, line, f"cycles.{comparator} must be a non-negative integer")
    error = expect.get("error")
    if error is not None:
        if not isinstance(error, dict) or not error:
            v.error(file, line, "expect.error must be a non-empty table")
        elif set(error) - {"code", "group"}:
            v.error(file, line, f"unsupported expect.error keys {sorted(set(error) - {'code', 'group'})}")
        if tx != "rejected":
            v.error(file, line, "expect.error requires expect.tx = rejected")


def validate_toml_semantics(v: Validation, file: Path, line: int, obj: dict[str, Any]) -> None:
    full_manifest = all(key in obj for key in ("meta", "toolchain", "setup"))
    meta = obj.get("meta")
    if isinstance(meta, dict) and meta.get("spec") != "0.1.0-draft.3":
        v.error(file, line, "manifest examples must select spec 0.1.0-draft.3")

    toolchain = obj.get("toolchain")
    if isinstance(toolchain, dict):
        required = {"ckb", "offckb"}
        allowed = required | {"ckb-debugger"}
        if not required.issubset(toolchain) or set(toolchain) - allowed:
            v.error(
                file,
                line,
                "toolchain requires ckb/offckb and permits optional ckb-debugger",
            )
        for name, version in toolchain.items():
            if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
                v.error(file, line, f"toolchain.{name} must be an exact version, not a range")

    validate_replay(v, file, line, obj.get("replay"), required=full_manifest)

    setup = obj.get("setup")
    if isinstance(setup, dict):
        accounts = setup.get("accounts")
        if accounts is not None and (
            isinstance(accounts, bool) or not isinstance(accounts, int) or not 0 <= accounts <= 20
        ):
            v.error(file, line, "setup.accounts must be an integer in 0..20")
        scripts = setup.get("scripts", {})
        if isinstance(scripts, dict):
            for name, script in scripts.items():
                if not isinstance(script, dict):
                    v.error(file, line, f"setup.scripts.{name} must be a table")
                    continue
                sources = [key for key in ("binary", "builtin") if key in script]
                if len(sources) != 1:
                    v.error(file, line, f"setup.scripts.{name} requires exactly one of binary/builtin")
                hash_type = script.get("hash_type")
                if hash_type is not None and hash_type not in ALLOWED_HASH_TYPES:
                    v.error(file, line, f"unsupported hash_type {hash_type!r}")

    steps = obj.get("step", [])
    if isinstance(steps, dict):
        steps = [steps]
    names: list[str] = []
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            name = step.get("name")
            if full_manifest and name is None:
                v.error(file, line, "every step in a full manifest requires a name")
            if name is not None:
                if not isinstance(name, str) or not name:
                    v.error(file, line, "step.name must be a non-empty string")
                elif name in names:
                    v.error(file, line, f"duplicate step name {name!r}")
                else:
                    names.append(name)
            if full_manifest and (not isinstance(step.get("run"), str) or not step.get("run")):
                v.error(file, line, "every step in a full manifest requires a non-empty run command")
            validate_expect(v, file, line, step.get("expect"))
            validate_assertions(v, file, line, step.get("assert"))
            validate_output_references(v, file, line, step.get("assert"), set(names))

    if full_manifest:
        def contains_assertion(table: Any) -> bool:
            return isinstance(table, dict) and any(
                isinstance(table.get(kind), list) and bool(table[kind])
                for kind in ("cell", "balance")
            )

        has_step_claim = isinstance(steps, list) and any(
            isinstance(step, dict)
            and (
                isinstance(step.get("expect"), dict)
                and bool(step["expect"])
                or contains_assertion(step.get("assert"))
            )
            for step in steps
        )
        if not has_step_claim and not contains_assertion(obj.get("assert")):
            v.error(file, line, "a full manifest requires at least one expectation or assertion")

    validate_assertions(v, file, line, obj.get("assert"))
    if isinstance(steps, list) and steps:
        validate_output_references(v, file, line, obj.get("assert"), set(names))

    for value in walk(obj):
        if not isinstance(value, dict):
            continue
        code_hash = value.get("code_hash")
        if isinstance(code_hash, str) and not re.fullmatch(r"0x[0-9a-fA-F]{64}", code_hash):
            v.error(file, line, "code_hash examples must contain exactly 32 bytes of hex")


def validate_report_example(v: Validation, file: Path, line: int, obj: dict[str, Any]) -> None:
    schema = obj.get("schema")
    if schema == "ckb-verify-report/1":
        required = {
            "schema",
            "verdict",
            "createdAt",
            "evidence",
            "outcomeClaims",
            "environment",
            "digests",
        }
        if set(obj) != required:
            v.error(
                file,
                line,
                f"current report requires top-level fields {sorted(required)}",
            )
        if obj.get("verdict") not in {"PASS", "FAIL"}:
            v.error(file, line, "current report verdict must be PASS or FAIL")
        if not isinstance(obj.get("createdAt"), str) or not obj["createdAt"]:
            v.error(file, line, "current report requires createdAt")

        evidence = obj.get("evidence")
        if not isinstance(evidence, dict):
            v.error(file, line, "current report requires evidence")
        outcome = obj.get("outcomeClaims")
        if not isinstance(outcome, dict) or outcome.get("schema") != "ckb-verify-outcome/1":
            v.error(file, line, "current report requires ckb-verify-outcome/1 outcomeClaims")
        environment = obj.get("environment")
        environment_fields = {"schema", "runner", "toolchain", "provenance", "platform", "devnet"}
        if not isinstance(environment, dict) or environment.get("schema") != "ckb-verify-environment/2":
            v.error(file, line, "current report requires ckb-verify-environment/2 environment")
        elif set(environment) != environment_fields:
            v.error(file, line, f"current environment requires fields {sorted(environment_fields)}")
        else:
            provenance = environment.get("provenance")
            if not isinstance(provenance, dict) or provenance.get("schema") != "ckb-verify-provenance/1":
                v.error(file, line, "current environment requires ckb-verify-provenance/1 provenance")
            else:
                replay = provenance.get("replay")
                if not isinstance(replay, dict) or replay.get("status") not in {"stable", "tainted"}:
                    v.error(file, line, "current provenance requires replay.status")
                elif not isinstance(replay.get("declaredDependencies"), list) or not isinstance(
                    replay.get("reasons"), list
                ):
                    v.error(file, line, "current provenance requires replay dependencies and reasons")

        digests = obj.get("digests")
        if not isinstance(digests, dict) or set(digests) != {"outcome", "environment"}:
            v.error(file, line, "current report requires outcome and environment digests")
        else:
            for name, digest in digests.items():
                if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
                    v.error(file, line, f"current report {name} digest must be canonical sha256")
        return

    if isinstance(schema, str) and schema.startswith("spark-verify-report/"):
        digests = obj.get("digests")
        replay = obj.get("replay")
        if not isinstance(digests, dict) or set(digests) != {"outcome", "environment"}:
            v.error(file, line, "report example requires outcome and environment digests")
        if not isinstance(replay, dict) or replay.get("status") not in {"stable", "tainted"}:
            v.error(file, line, "report example requires replay.status")
        elif not isinstance(replay.get("declared_dependencies"), list):
            v.error(file, line, "report example requires replay.declared_dependencies")


def validate_markdown(v: Validation, file: Path, external_links: set[str]) -> None:
    text = file.read_text(encoding="utf-8")
    for label, pattern in SECRET_PATTERNS.items():
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            v.error(file, line, f"possible {label}")

    for match in FENCE_RE.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        lang, body = match.group("lang"), match.group("body")
        try:
            if lang == "toml":
                obj = tomllib.loads(body)
                v.toml_count += 1
                validate_toml_semantics(v, file, line, obj)
            else:
                obj = json.loads(body)
                v.json_count += 1
                if isinstance(obj, dict):
                    validate_report_example(v, file, line, obj)
        except (tomllib.TOMLDecodeError, json.JSONDecodeError) as exc:
            v.error(file, line, f"invalid {lang} fence: {exc}")

    for match in LINK_RE.finditer(text):
        raw = match.group(1).strip()
        if raw.startswith(("http://", "https://")):
            external_links.add(raw)
            continue
        if raw.startswith(("#", "mailto:")):
            continue
        target = urllib.parse.unquote(raw.split("#", 1)[0])
        if target and not (file.parent / target).resolve().exists():
            line = text.count("\n", 0, match.start()) + 1
            v.error(file, line, f"missing local link target {raw!r}")


def check_external_links(v: Validation, links: set[str]) -> None:
    for url in sorted(links):
        request = urllib.request.Request(url, headers={"User-Agent": "spark-verify-doc-validator/1"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                if response.status >= 400:
                    v.errors.append(f"external link returned HTTP {response.status}: {url}")
        except urllib.error.HTTPError as exc:
            v.errors.append(f"external link returned HTTP {exc.code}: {url}")
        except (urllib.error.URLError, TimeoutError) as exc:
            v.errors.append(f"external link failed: {url}: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--examples",
        action="store_true",
        help="explicitly request embedded TOML/JSON validation (enabled by default)",
    )
    parser.add_argument("--external-links", action="store_true", help="also fetch every external Markdown link")
    args = parser.parse_args()

    validation = Validation()
    links: set[str] = set()
    markdown = sorted(
        file
        for file in ROOT.rglob("*.md")
        if not set(file.relative_to(ROOT).parts).intersection(IGNORED_PARTS)
    )
    for file in markdown:
        validate_markdown(validation, file, links)
    if args.external_links:
        check_external_links(validation, links)

    if validation.errors:
        print("documentation validation failed:", file=sys.stderr)
        for error in validation.errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    link_state = "checked" if args.external_links else "discovered"
    print(
        f"validated {len(markdown)} Markdown files, "
        f"{validation.toml_count} TOML fences, {validation.json_count} JSON fences, "
        f"{len(links)} external links {link_state}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
