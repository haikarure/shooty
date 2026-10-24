#!/usr/bin/env python3
"""Compare isolated, last-call Forge gas snapshots with an archived baseline."""
import argparse
import json
from pathlib import Path


def measurements(path):
    document = json.loads(Path(path).read_text())
    if "operationGas" in document:
        return document["operationGas"]
    values = {}
    for suite in document.values():
        for name, result in suite["test_results"].items():
            if result["status"] != "Success":
                raise ValueError(f"Correctness gate failed: {name}")
            for group, snapshots in result.get("gas_snapshots", {}).items():
                for operation, gas in snapshots.items():
                    key = f"{group}/{operation}"
                    if key in values:
                        raise ValueError(f"Duplicate snapshot: {key}")
                    values[key] = int(gas)
    if not values:
        raise ValueError("No operation snapshots; run ShootyArenaGasTest with --isolate --json")
    return values


def compare(before, after):
    if before.keys() != after.keys():
        raise ValueError("Benchmark scenarios differ between baseline and candidate")
    operations = {
        key: {"before": before[key], "after": after[key], "saved": before[key] - after[key]}
        for key in sorted(before)
    }
    lifecycles = {}
    for mode in ("Duel", "Team", "Rumble"):
        keys = [key for key in before if key.startswith(mode + "/")]
        old, new = sum(before[key] for key in keys), sum(after[key] for key in keys)
        lifecycles[mode] = {"before": old, "after": new, "saved": old - new}
    return {"metric": "isolated callee execution gas, Cancun EVM", "operations": operations, "lifecycles": lifecycles}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = compare(measurements(args.baseline), measurements(args.candidate))
    print(f"{'Operation':42} {'Before':>10} {'After':>10} {'Saved':>9}")
    for key, row in report["operations"].items():
        print(f"{key:42} {row['before']:10} {row['after']:10} {row['saved']:9}")
    for mode, row in report["lifecycles"].items():
        print(f"{mode + ' full winning lifecycle':42} {row['before']:10} {row['after']:10} {row['saved']:9}")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
