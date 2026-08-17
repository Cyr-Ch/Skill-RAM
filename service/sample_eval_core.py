from __future__ import annotations

import argparse
import gzip
import hashlib
import heapq
import json
import os
import re
import shutil
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator


TOKEN_PATTERN = re.compile(r"[\w]+|[^\s\w]", re.UNICODE)


TIER_VARIANT = re.compile(r"^distractor/dist_(?P<target>.+)_[0-9a-f]+$")


def jsonl(path: Path) -> Iterator[dict[str, Any]]:
    files = sorted(path.rglob("*.jsonl")) + sorted(path.rglob("*.jsonl.gz")) if path.is_dir() else [path]
    for file in files:
        opener = gzip.open if file.suffix == ".gz" else open
        with opener(file, "rt", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)


def stable_number(seed: str, value: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}\0{value}".encode("utf-8")).digest(), "big")


def skill_identifier(skill: dict[str, Any]) -> str:
    return str(skill.get("skill_id") or skill["id"])


def words(value: str) -> set[str]:
    return {token.lower() for token in TOKEN_PATTERN.findall(value) if len(token) >= 3 and token[0].isalnum()}


def numeric_value(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def select_tasks(tasks: list[dict[str, Any]], relevance: dict[str, Any], limit: int, seed: str) -> list[dict[str, Any]]:
    scorable = [
        task for task in tasks
        if (labels := relevance.get(str(task["task_id"]), {})).get("task_type") != "generic_only"
        and (labels.get("core_gt_ids") or labels.get("gt_skill_ids"))
    ]
    if not scorable:
        raise ValueError("The source dataset has no scorable tasks")
    limit = min(limit, len(scorable))
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for task in scorable:
        groups[str(relevance[str(task["task_id"])].get("task_type", "unknown"))].append(task)

    allocation = {kind: int(limit * len(group) / len(scorable)) for kind, group in groups.items()}
    while sum(allocation.values()) < limit:
        candidates = [kind for kind, group in groups.items() if allocation[kind] < len(group)]
        kind = max(candidates, key=lambda item: (limit * len(groups[item]) / len(scorable) - allocation[item], item))
        allocation[kind] += 1

    selected_ids: set[str] = set()
    for kind, group in groups.items():
        ranked = sorted(group, key=lambda task: stable_number(seed, str(task["task_id"])))
        selected_ids.update(str(task["task_id"]) for task in ranked[:allocation[kind]])
    return [task for task in tasks if str(task["task_id"]) in selected_ids]


def push_best(heap: list[tuple[Any, ...]], quality: tuple[Any, ...], limit: int) -> None:
    if limit <= 0:
        return
    if len(heap) < limit:
        heapq.heappush(heap, quality)
    elif quality > heap[0]:
        heapq.heapreplace(heap, quality)


def sample_pool_ids(pool: Path, selected_tasks: list[dict[str, Any]], selected_relevance: dict[str, Any], skill_limit: int, seed: str) -> tuple[set[str], dict[str, int]]:
    graded = {
        str(skill_id)
        for labels in selected_relevance.values()
        for skill_id, grade in labels.get("relevance", {}).items()
        if numeric_value(grade) > 0
    }
    core_required: set[str] = set()
    for labels in selected_relevance.values():
        core_required.update(map(str, labels.get("core_gt_ids") or labels.get("gt_skill_ids") or []))
    labeled = graded | core_required
    if len(core_required) > skill_limit:
        raise ValueError(f"--sample-skills must be at least {len(core_required)} to retain every core gold skill")

    # The hard tier is the easy pool plus adversarial variants named
    # distractor/dist_<gold-skill>_<hash>. They are what makes the tier hard, but they are
    # only 780 of roughly 79,000 records, so a lexical or random draw of a few hundred
    # skills almost never keeps them and the sample scores identically to easy. Retain the
    # variants that target the selected tasks' own gold skills instead of leaving it to chance.
    targeted = {skill_id.split("/", 1)[1] for skill_id in core_required if "/" in skill_id}
    tier_variants: set[str] = set()

    task_words = [words(str(task.get("instruction_text", ""))) for task in selected_tasks]
    # Keep enough metadata candidates to choose the exact hard/random split
    # after discovering which tier-specific graded variants are present.
    candidate_limit = skill_limit * 2 + 32
    hard: list[tuple[float, int, str]] = []
    random: list[tuple[int, str]] = []
    found_labeled: set[str] = set()
    source_records = 0

    for skill in jsonl(pool):
        source_records += 1
        skill_id = skill_identifier(skill)
        if skill_id in labeled:
            found_labeled.add(skill_id)
            continue
        variant = TIER_VARIANT.match(skill_id)
        if variant and variant.group("target") in targeted:
            tier_variants.add(skill_id)
            continue
        metadata_words = words(f"{skill.get('name', '')} {skill.get('description') or skill.get('desc') or ''}")
        overlap = max((len(metadata_words & query) / max(1, len(query)) for query in task_words), default=0.0)
        rank = stable_number(seed, skill_id)
        push_best(hard, (overlap, -rank, skill_id), candidate_limit)
        push_best(random, (-rank, skill_id), candidate_limit)

    missing_core = core_required - found_labeled
    if missing_core:
        raise ValueError(f"The {pool.name} pool is missing {len(missing_core)} core gold skills required by the selected tasks")
    required = core_required | (graded & found_labeled)
    if len(required) > skill_limit:
        raise ValueError(f"--sample-skills must be at least {len(required)} to retain every tier-valid graded skill")

    # Tier variants rank just behind the graded skills. If the budget cannot hold them all,
    # drop deterministically and report the count rather than silently weakening the tier.
    variant_budget = max(0, skill_limit - len(required))
    kept_variants = sorted(tier_variants, key=lambda value: stable_number(seed, value))[:variant_budget]
    dropped_variants = len(tier_variants) - len(kept_variants)
    reserved = required | set(kept_variants)

    available = skill_limit - len(reserved)
    hard_limit = available // 2
    hard_ids = {item[2] for item in sorted(hard, reverse=True)[:hard_limit] if item[2] not in reserved}
    random_ids = [item[1] for item in sorted(random, reverse=True) if item[1] not in hard_ids and item[1] not in reserved]
    random_ids = random_ids[:available - len(hard_ids)]
    selected = reserved | hard_ids | set(random_ids)
    if len(selected) != skill_limit:
        raise ValueError(f"Could only select {len(selected)} of the requested {skill_limit} skills")
    return selected, {
        "sourceRecords": source_records,
        "requiredGradedSkills": len(required),
        "tierExcludedGradedSkills": len(graded - found_labeled),
        "tierVariantsRetained": len(kept_variants),
        "tierVariantsDropped": dropped_variants,
        "lexicalHardDistractors": len(hard_ids),
        "randomDistractors": len(random_ids),
    }


def write_sample(source: Path, output: Path, tier: str, task_limit: int, skill_limit: int, seed: str) -> dict[str, Any]:
    settings = {"source": str(source.resolve()), "tier": tier, "tasks": task_limit, "skills": skill_limit, "seed": seed}
    manifest_file = output / "manifest.json"
    if manifest_file.exists():
        existing = json.loads(manifest_file.read_text(encoding="utf-8"))
        if existing.get("sample") == settings:
            print(json.dumps({"output": str(output.resolve()), **existing["sampleStats"]}), flush=True)
            return existing
        raise ValueError(f"Sample output already exists with different settings: {output}")

    tasks = list(jsonl(source / "tasks.jsonl"))
    relevance = json.loads((source / "relevance.json").read_text(encoding="utf-8"))
    selected_tasks = select_tasks(tasks, relevance, task_limit, seed)
    selected_relevance = {str(task["task_id"]): relevance[str(task["task_id"])] for task in selected_tasks}
    selected_ids, stats = sample_pool_ids(source / tier, selected_tasks, selected_relevance, skill_limit, seed)
    selected_relevance = {
        task_id: {
            **labels,
            "relevance": {skill_id: grade for skill_id, grade in labels.get("relevance", {}).items() if str(skill_id) in selected_ids},
        }
        for task_id, labels in selected_relevance.items()
    }

    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        (temporary / tier).mkdir(mode=0o700)
        (temporary / "tasks.jsonl").write_text("".join(json.dumps(task) + "\n" for task in selected_tasks), encoding="utf-8")
        (temporary / "relevance.json").write_text(json.dumps(selected_relevance, indent=2) + "\n", encoding="utf-8")
        pool_target = temporary / tier / "pool.jsonl.gz"
        written = 0
        with gzip.open(pool_target, "wt", encoding="utf-8") as handle:
            for skill in jsonl(source / tier):
                if skill_identifier(skill) in selected_ids:
                    handle.write(json.dumps(skill) + "\n")
                    written += 1
        if written != skill_limit:
            raise ValueError(f"Expected to write {skill_limit} skills, wrote {written}")
        manifest = {
            "dataset_name": "skillrouter-eval-core-development-mini",
            "sample": settings,
            "sampleStats": {**stats, "selectedTasks": len(selected_tasks), "selectedSkills": written},
            "tasks": {"format": "jsonl", "path": "tasks.jsonl", "records": len(selected_tasks)},
            "relevance": {"format": "json", "path": "relevance.json", "records": len(selected_relevance)},
            tier: {"format": "jsonl", "compression": "gzip", "records": written, "parts": [{"path": f"{tier}/pool.jsonl.gz", "records": written}]},
        }
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        for file in temporary.rglob("*"):
            if file.is_file():
                os.chmod(file, 0o600)
        os.replace(temporary, output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    print(json.dumps({"output": str(output.resolve()), **manifest["sampleStats"]}), flush=True)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a valid bounded SkillRouter Eval Core development sample.")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tier", choices=["easy", "hard"], default="easy")
    parser.add_argument("--sample-tasks", type=int, default=30)
    parser.add_argument("--sample-skills", type=int, default=1000)
    parser.add_argument("--seed", default="skillram-dev-v1")
    args = parser.parse_args()
    if args.sample_tasks < 1 or args.sample_skills < 1:
        raise SystemExit("Sample sizes must be positive")
    write_sample(Path(args.data_root).resolve(), Path(args.output).resolve(), args.tier, args.sample_tasks, args.sample_skills, args.seed)


if __name__ == "__main__":
    main()
