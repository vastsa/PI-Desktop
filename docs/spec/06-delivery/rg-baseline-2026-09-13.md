# Workspace index rg baseline (P2-0)

- Date: 2026-09-13
- Machine: macOS arm64 (development workstation)
- rg: system `rg` via PATH, invoked as the host's `try_system_rg` does
  (`--json --no-config --hidden -e <pattern> -- <dir>`), stdout discarded
- Fixture: generated trees of 100 / 1,000 / 5,000 one-line text files; each file
  contains `fn_<i> commonToken id`, every 37th file adds a CJK line, and the
  last file adds the per-size rare needle `needle_<size-1>` (always ≥1 hit)
- Method: 8 runs per cell; `first_ms` is run 1, `warm_p50/p95` over runs 2–8
- Script: `scripts/rg-baseline.py` (re-run with `python3 scripts/rg-baseline.py`)

| files | query | first_ms | warm_p50_ms | warm_p95_ms |
|---|---|---|---|---|
| 100 | common_literal | 24.0 | 10.5 | 15.9 |
| 100 | cjk_literal | 14.5 | 12.0 | 19.5 |
| 100 | short_pattern | 9.2 | 9.9 | 12.1 |
| 100 | regex_pattern | 10.9 | 10.0 | 10.7 |
| 100 | rare_literal | 8.9 | 10.0 | 12.6 |
| 1000 | common_literal | 20.2 | 16.7 | 17.1 |
| 1000 | cjk_literal | 16.1 | 15.8 | 18.3 |
| 1000 | short_pattern | 16.6 | 16.6 | 18.0 |
| 1000 | regex_pattern | 16.2 | 17.2 | 17.6 |
| 1000 | rare_literal | 16.8 | 16.6 | 17.0 |
| 5000 | common_literal | 92.9 | 52.9 | 54.3 |
| 5000 | cjk_literal | 61.5 | 66.0 | 69.3 |
| 5000 | short_pattern | 63.2 | 65.0 | 67.4 |
| 5000 | regex_pattern | 69.2 | 67.1 | 165.5 |
| 5000 | rare_literal | 63.3 | 59.8 | 80.3 |

Notes for P2-B calibration (single-machine, single-session evidence, not a
promise):

- Process-spawn `rg` costs ~10–17ms warm at 100–1k files and ~53–67ms at 5k on
  this machine. The fast path only has to beat this on the literal subset, and
  its own admission-check overhead must stay well under ~1ms so fallback never
  regresses against this baseline.
- Warm p95 is mostly close to p50; occasional outliers (165ms at 5k regex) are
  scheduler noise. P2-B timing assertions should use p50 first and either a
  generous p95 or outlier dropping.
- The first (cold) run can be noticeably slower than warm p50 (e.g. ~93ms vs
  ~53ms at 5k common); treat cold-cache as a separate reported percentile.
- No claim here transfers across machines or OSes; re-run before treating any
  number as a gate.
