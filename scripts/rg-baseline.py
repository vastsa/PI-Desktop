import json, os, pathlib, shutil, statistics, subprocess, tempfile, time

root = pathlib.Path(tempfile.mkdtemp(prefix="pi-rg-baseline-"))
results = []
queries = {
    "common_literal": "commonToken",
    "cjk_literal": "索引基线",
    "short_pattern": "id",
    "regex_pattern": r"fn_[0-9]+",
}
try:
    for size in (100, 1000, 5000):
        fixture = root / str(size)
        fixture.mkdir()
        for i in range(size):
            content = [f"fn_{i} commonToken id\n"]
            if i % 37 == 0:
                content.append("索引基线 中文内容\n")
            if i == size - 1:
                content.append(f"needle_{i}\n")
            (fixture / f"file_{i:05d}.txt").write_text("".join(content), encoding="utf-8")
        for label, pattern in {**queries, "rare_literal": f"needle_{size - 1}"}.items():
            timings = []
            for run in range(8):
                start = time.perf_counter_ns()
                completed = subprocess.run(
                    ["rg", "--json", "--no-config", "--hidden", "-e", pattern, "--", str(fixture)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
                if completed.returncode not in (0, 1):
                    raise RuntimeError(completed.stderr.decode("utf-8", "replace"))
                timings.append(elapsed_ms)
            sorted_times = sorted(timings[1:])
            p95_index = min(len(sorted_times) - 1, int(0.95 * len(sorted_times)))
            results.append({
                "files": size,
                "query": label,
                "pattern": pattern,
                "first_ms": round(timings[0], 3),
                "warm_p50_ms": round(statistics.median(sorted_times), 3),
                "warm_p95_ms": round(sorted_times[p95_index], 3),
                "runs": len(timings),
            })
    print(json.dumps(results, ensure_ascii=False, indent=2))
finally:
    shutil.rmtree(root, ignore_errors=True)
