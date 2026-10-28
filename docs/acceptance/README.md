# Acceptance records

Retained outputs of `scripts/acceptance-matrix.sh` and `scripts/release-rehearsal.sh`, one file per run, named by date and mode. Each record states the platform, Bun and Node versions, runner version, and the exact project commit it ran against; a row is `PASS` only when the observed exit code, verdict, and closeout matched the expectation. Records are evidence of what ran on that host and commit, not a claim about other platforms.
