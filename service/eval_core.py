from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterable, Iterator

import torch
from safetensors.torch import load_file, save_file

from skillrouter_service import Models

try:
    import resource
except ImportError:  # Windows does not provide the Unix resource module.
    resource = None

CACHE_VERSION = 1
TOKEN_PATTERN = re.compile(r"[\w]+|[^\s\w]", re.UNICODE)


def jsonl_files(path: Path) -> list[Path]:
    if path.is_dir():
        return sorted(path.rglob("*.jsonl")) + sorted(path.rglob("*.jsonl.gz"))
    return [path]


def jsonl(path: Path) -> Iterator[dict[str, Any]]:
    for file in jsonl_files(path):
        opener = gzip.open if file.suffix == ".gz" else open
        with opener(file, "rt", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)


def batches(values: Iterable[Any], size: int) -> Iterator[list[Any]]:
    batch: list[Any] = []
    for value in values:
        batch.append(value)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def sha256_files(root: Path, files: list[Path]) -> str:
    digest = hashlib.sha256()
    for file in files:
        digest.update(str(file.relative_to(root)).encode("utf-8"))
        digest.update(b"\0")
        with file.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()


def skillrouter_files(root: Path, tier: str) -> list[Path]:
    files = [root / "tasks.jsonl", root / "relevance.json"]
    manifest = root / "manifest.json"
    if manifest.exists():
        files.append(manifest)
    files.extend(jsonl_files(root / tier))
    return files


def split_file(root: Path, kind: str, split: str) -> Path:
    candidates = [
        root / "data" / kind / f"{split}.jsonl",
        root / "data" / kind / f"{split}.jsonl.gz",
        root / kind / f"{split}.jsonl",
        root / kind / f"{split}.jsonl.gz",
    ]
    return next((candidate for candidate in candidates if candidate.exists()), candidates[0])


def detect_dataset(root: Path, requested: str) -> str:
    if requested != "auto":
        return requested
    if (root / "tasks.jsonl").exists() and (root / "relevance.json").exists():
        return "skillrouter"
    if split_file(root, "skills", "test").exists() and split_file(root, "queries", "test").exists():
        return "skillret"
    raise ValueError("Could not detect a supported public dataset. Use --dataset skillrouter or --dataset skillret.")


def dataset_spec(root: Path, dataset: str, tier: str, split: str) -> dict[str, Any]:
    if dataset == "skillrouter":
        return {
            "dataset": dataset,
            "partition": tier,
            "tasks": list(jsonl(root / "tasks.jsonl")),
            "pool": root / tier,
            "files": skillrouter_files(root, tier),
            "total": expected_records(root, tier),
        }
    skills = split_file(root, "skills", split)
    queries = split_file(root, "queries", split)
    qrels = split_file(root, "qrels", split)
    records = list(jsonl(queries))
    return {
        "dataset": dataset,
        "partition": split,
        "tasks": [{"task_id": str(item["id"]), "instruction_text": item["query"]} for item in records],
        "pool": skills,
        "files": [skills, queries, qrels],
        "total": sum(1 for _ in jsonl(skills)),
    }


def dataset_fingerprint(root: Path, files: list[Path]) -> str:
    missing = [str(file) for file in files if not file.exists()]
    if missing:
        raise FileNotFoundError(f"Public benchmark is incomplete; missing: {', '.join(missing)}")
    print(f"[setup] Fingerprinting {len(files)} dataset files...", flush=True)
    return sha256_files(root, files)


def model_fingerprint(models_root: Path) -> str:
    files = [models_root / "manifest.json"]
    if not files[0].exists():
        files = [models_root / "embedding" / "config.json", models_root / "reranker" / "config.json"]
    return sha256_files(models_root, files)


def expected_records(root: Path, tier: str) -> int | None:
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        return int(manifest[tier]["records"])
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def format_duration(seconds: float) -> str:
    if not math.isfinite(seconds) or seconds < 0:
        return "?"
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60}m"


class Progress:
    def __init__(self, label: str, total: int | None, start: int = 0, interval: float = 5.0) -> None:
        self.label = label
        self.total = total
        self.start_count = start
        self.interval = interval
        self.started = time.monotonic()
        self.last_print = 0.0
        self.update(start, force=True)

    def update(self, count: int, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_print < self.interval and count != self.total:
            return
        elapsed = max(0.001, now - self.started)
        completed = max(0, count - self.start_count)
        rate = completed / elapsed
        if self.total is None:
            detail = f"{count:,} · {rate:.1f}/s"
        else:
            remaining = max(0, self.total - count)
            eta = remaining / rate if rate else math.inf
            percent = 100 * count / max(1, self.total)
            detail = f"{count:,}/{self.total:,} ({percent:.1f}%) · {rate:.1f}/s · ETA {format_duration(eta)}"
        print(f"[{self.label}] {detail}", flush=True)
        self.last_print = now


def cache_metadata(dataset_hash: str, model_hash: str, tier: str, dataset: str = "skillrouter") -> dict[str, Any]:
    metadata = {"version": CACHE_VERSION, "datasetSha256": dataset_hash, "modelSha256": model_hash, "tier": tier}
    # Preserve SkillRouter v1 cache identity for in-flight and existing runs.
    if dataset != "skillrouter":
        metadata["dataset"] = dataset
    return metadata


def load_pool_state(cache_root: Path, expected: dict[str, Any]) -> dict[str, Any]:
    state_file = cache_root / "pool-state.json"
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        if any(state.get(key) != value for key, value in expected.items()):
            raise ValueError("cache metadata mismatch")
        completed = sum(int(shard["records"]) for shard in state.get("shards", []))
        if completed != state.get("completed"):
            raise ValueError("cache record count mismatch")
        for shard in state.get("shards", []):
            if not (cache_root / shard["vectors"]).is_file() or not (cache_root / shard["ids"]).is_file():
                raise ValueError("cache shard is missing")
        return state
    except FileNotFoundError:
        return {**expected, "completed": 0, "dimensions": None, "shards": []}


def save_pool_shard(cache_root: Path, state: dict[str, Any], vectors: torch.Tensor, ids: list[str]) -> None:
    number = len(state["shards"])
    vector_name = f"pool-{number:05d}.safetensors"
    ids_name = f"pool-{number:05d}.ids.json"
    vector_target = cache_root / vector_name
    vector_temporary = cache_root / f".{vector_name}.{os.getpid()}.tmp"
    save_file({"vectors": vectors.contiguous()}, str(vector_temporary))
    os.chmod(vector_temporary, 0o600)
    os.replace(vector_temporary, vector_target)
    atomic_json(cache_root / ids_name, ids)
    state["dimensions"] = int(vectors.shape[1])
    state["completed"] += len(ids)
    state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state["shards"].append({"vectors": vector_name, "ids": ids_name, "records": len(ids)})
    atomic_json(cache_root / "pool-state.json", state)


def embed_queries(models: Models, tasks: list[dict[str, Any]], batch_size: int, cache_root: Path, expected: dict[str, Any]) -> torch.Tensor:
    vectors_file = cache_root / "queries.safetensors"
    metadata_file = cache_root / "queries.json"
    task_ids = [task["task_id"] for task in tasks]
    try:
        metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        if any(metadata.get(key) != value for key, value in expected.items()) or metadata.get("taskIds") != task_ids:
            raise ValueError("query cache mismatch")
        vectors = load_file(str(vectors_file))["vectors"]
        if vectors.shape[0] != len(tasks):
            raise ValueError("query cache size mismatch")
        print(f"[queries] Reusing {len(tasks):,} cached query embeddings.", flush=True)
        return vectors
    except (FileNotFoundError, ValueError, KeyError, json.JSONDecodeError):
        pass

    progress = Progress("queries", len(tasks))
    chunks = []
    completed = 0
    for task_batch in batches(tasks, batch_size):
        chunks.append(models.embed_tensor([task["instruction_text"] for task in task_batch], "query"))
        completed += len(task_batch)
        progress.update(completed, force=True)
    vectors = torch.cat(chunks, dim=0)
    temporary = cache_root / f".queries.safetensors.{os.getpid()}.tmp"
    save_file({"vectors": vectors.contiguous()}, str(temporary))
    os.chmod(temporary, 0o600)
    os.replace(temporary, vectors_file)
    atomic_json(metadata_file, {**expected, "taskIds": task_ids, "dimensions": int(vectors.shape[1])})
    return vectors


def skill_document(skill: dict[str, Any]) -> str:
    return f"{skill.get('name', '')} | {(skill.get('description') or skill.get('desc') or '')[:500]} | {(skill.get('body') or skill.get('skill_md') or '')[:8000]}"


def skill_identifier(skill: dict[str, Any]) -> str:
    return str(skill.get("skill_id") or skill["id"])


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, math.ceil(len(TOKEN_PATTERN.findall(text.strip())) * 1.28))


def embed_pool(models: Models, pool_path: Path, batch_size: int, checkpoint_every: int, cache_root: Path, expected: dict[str, Any], total: int | None) -> dict[str, Any]:
    state = load_pool_state(cache_root, expected)
    state["total"] = total
    state["dataset"] = expected.get("dataset", "skillrouter")
    state["partition"] = expected["tier"]
    atomic_json(cache_root / "pool-state.json", state)
    if total is not None and state["completed"] > total:
        raise ValueError("embedding cache contains more skills than the dataset")
    if total is not None and state["completed"] == total:
        print(f"[pool] Reusing {total:,} cached skill embeddings across {len(state['shards'])} shards.", flush=True)
        return state

    progress = Progress("pool", total, state["completed"])
    pending_vectors: list[torch.Tensor] = []
    pending_ids: list[str] = []
    batch_items: list[dict[str, Any]] = []
    seen = 0

    def flush_batch() -> None:
        nonlocal batch_items
        if not batch_items:
            return
        pending_vectors.append(models.embed_tensor([skill_document(skill) for skill in batch_items], "document"))
        pending_ids.extend(skill_identifier(skill) for skill in batch_items)
        batch_items = []

    def flush_checkpoint() -> None:
        if not pending_ids:
            return
        save_pool_shard(cache_root, state, torch.cat(pending_vectors, dim=0), list(pending_ids))
        pending_vectors.clear()
        pending_ids.clear()
        progress.update(state["completed"], force=True)

    try:
        for skill in jsonl(pool_path):
            if seen < state["completed"]:
                seen += 1
                continue
            seen += 1
            batch_items.append(skill)
            if len(batch_items) >= batch_size:
                flush_batch()
            if len(pending_ids) >= checkpoint_every:
                flush_checkpoint()
            else:
                progress.update(state["completed"] + len(pending_ids))
        flush_batch()
        flush_checkpoint()
    except KeyboardInterrupt:
        # Preserve only batches that completed inference. Retrying the batch
        # that received Ctrl-C can immediately re-enter a wedged accelerator.
        flush_checkpoint()
        print("\n[pool] Interrupted safely; cached embeddings will resume on the next run.", flush=True)
        raise
    if total is not None and state["completed"] != total:
        raise ValueError(f"dataset manifest expected {total} skills but read {state['completed']}")
    return state


def retrieval_cache_key(expected: dict[str, Any], retrieval_k: int, task_ids: list[str]) -> str:
    payload = json.dumps({**expected, "retrievalK": retrieval_k, "taskIds": task_ids}, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def retrieve(cache_root: Path, state: dict[str, Any], queries: torch.Tensor, tasks: list[dict[str, Any]], retrieval_k: int, expected: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    task_ids = [task["task_id"] for task in tasks]
    key = retrieval_cache_key(expected, retrieval_k, task_ids)
    target = cache_root / f"retrieval-{key}.json"
    try:
        cached = json.loads(target.read_text(encoding="utf-8"))
        print(f"[retrieval] Reusing cached top-{retrieval_k} candidates.", flush=True)
        return cached["candidates"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        pass

    best: list[list[tuple[float, str]]] = [[] for _ in tasks]
    progress = Progress("retrieval", state["completed"])
    completed = 0
    for shard in state["shards"]:
        vectors = load_file(str(cache_root / shard["vectors"]))["vectors"]
        ids = json.loads((cache_root / shard["ids"]).read_text(encoding="utf-8"))
        scores = queries @ vectors.T
        local_k = min(retrieval_k, len(ids))
        values, indices = torch.topk(scores, local_k, dim=1)
        for task_position in range(len(tasks)):
            additions = [(float(score), ids[int(index)]) for score, index in zip(values[task_position], indices[task_position])]
            best[task_position] = sorted(best[task_position] + additions, key=lambda item: (-item[0], item[1]))[:retrieval_k]
        completed += len(ids)
        progress.update(completed)
    progress.update(completed, force=True)
    candidates = {
        task["task_id"]: [{"id": skill_id, "score": score} for score, skill_id in best[position]]
        for position, task in enumerate(tasks)
    }
    atomic_json(target, {**expected, "retrievalK": retrieval_k, "candidates": candidates})
    return candidates


def load_candidate_bodies(pool_path: Path, wanted: set[str]) -> dict[str, dict[str, Any]]:
    print(f"[rerank] Loading {len(wanted):,} retrieved skill bodies from the compressed pool...", flush=True)
    found: dict[str, dict[str, Any]] = {}
    for skill in jsonl(pool_path):
        skill_id = skill_identifier(skill)
        if skill_id in wanted:
            found[skill_id] = {**skill, "id": skill_id}
            if len(found) == len(wanted):
                break
    missing = wanted - found.keys()
    if missing:
        raise ValueError(f"retrieval cache references {len(missing)} skills missing from the dataset")
    return found


def rerank(models: Models, pool_path: Path, tasks: list[dict[str, Any]], retrieval: dict[str, list[dict[str, Any]]], output: Path, checkpoint: Path, expected: dict[str, Any], retrieval_k: int) -> None:
    checkpoint_metadata = {**expected, "retrievalK": retrieval_k, "taskIds": [task["task_id"] for task in tasks]}
    predictions: dict[str, list[str]] = {}
    try:
        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
        if any(saved.get(key) != value for key, value in checkpoint_metadata.items()):
            raise ValueError("prediction checkpoint mismatch")
        predictions = json.loads(output.read_text(encoding="utf-8"))
        if not set(predictions).issubset(set(checkpoint_metadata["taskIds"])):
            raise ValueError("prediction checkpoint contains unknown tasks")
        if predictions:
            print(f"[rerank] Resuming with {len(predictions):,}/{len(tasks):,} tasks already complete.", flush=True)
    except (FileNotFoundError, ValueError, KeyError, json.JSONDecodeError):
        predictions = {}

    remaining = [task for task in tasks if task["task_id"] not in predictions]
    if not remaining:
        print("[rerank] Reusing complete predictions.", flush=True)
        return
    wanted = {candidate["id"] for task in remaining for candidate in retrieval[task["task_id"]]}
    bodies = load_candidate_bodies(pool_path, wanted)
    progress = Progress("rerank", len(tasks), len(predictions))
    try:
        for task in remaining:
            candidates = [bodies[item["id"]] for item in retrieval[task["task_id"]]]
            ranking = models.rerank(task["instruction_text"], candidates)
            predictions[task["task_id"]] = [item["id"] for item in ranking]
            atomic_json(output, predictions)
            atomic_json(checkpoint, {**checkpoint_metadata, "completed": len(predictions)})
            progress.update(len(predictions), force=True)
    except KeyboardInterrupt:
        print("\n[rerank] Interrupted safely; completed task rankings will resume on the next run.", flush=True)
        raise


def context_token_metrics(pool_path: Path, predictions: dict[str, list[str]], load_k: int) -> dict[str, Any]:
    selected_by_task = {task_id: list(map(str, ranking[:load_k])) for task_id, ranking in predictions.items()}
    wanted = {skill_id for ranking in selected_by_task.values() for skill_id in ranking}
    selected_tokens: dict[str, int] = {}
    catalog_tokens = 0
    pool_skills = 0
    for skill in jsonl(pool_path):
        pool_skills += 1
        skill_id = skill_identifier(skill)
        metadata = f"{skill.get('name', '')}\n{skill.get('description') or skill.get('desc') or ''}"
        catalog_tokens += estimate_tokens(metadata)
        if skill_id in wanted:
            selected_tokens[skill_id] = estimate_tokens(str(skill.get("body") or skill.get("skill_md") or ""))
    missing = wanted - selected_tokens.keys()
    if missing:
        raise ValueError(f"Predictions reference {len(missing)} skills missing from the token accounting pool")
    loaded = sum(selected_tokens[skill_id] for ranking in selected_by_task.values() for skill_id in ranking)
    queries = len(selected_by_task)
    baseline = catalog_tokens * queries
    avoided = baseline - loaded
    return {
        "scope": "skill context only",
        "estimator": "SkillRAM lexical heuristic (approximately 1.28 tokens per word/punctuation unit)",
        "loadK": load_k,
        "poolSkills": pool_skills,
        "queries": queries,
        "catalogTokensPerPromptBefore": catalog_tokens,
        "catalogTokensPerPromptAfter": 0,
        "baselineCatalogTokensAcrossQueries": baseline,
        "loadedInstructionTokensAcrossQueries": loaded,
        "meanLoadedInstructionTokensPerQuery": loaded / max(1, queries),
        "estimatedTokensAvoided": avoided,
        "estimatedReduction": avoided / baseline if baseline else 0,
    }


def automatic_batch_size(device: torch.device) -> int:
    if device.type == "cuda":
        return 16
    if device.type == "mps":
        return 2
    return 2


def main() -> None:
    evaluation_started = time.monotonic()
    parser = argparse.ArgumentParser(description="Run SkillRAM's SkillRouter backend against SkillRouter Eval Core.")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--dataset", choices=["auto", "skillrouter", "skillret"], default="auto")
    parser.add_argument("--tier", choices=["easy", "hard"], required=True)
    parser.add_argument("--split", choices=["train", "test"], default="test")
    parser.add_argument("--models", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--retrieval-k", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=0, help="0 chooses a device-safe default")
    parser.add_argument("--checkpoint-every", type=int, default=512)
    parser.add_argument("--load-k", type=int, default=2, help="Top-ranked skills assumed to be loaded for context accounting")
    args = parser.parse_args()

    root = Path(args.data_root).resolve()
    models_root = Path(args.models).resolve()
    output = Path(args.output).resolve()
    dataset = detect_dataset(root, args.dataset)
    spec = dataset_spec(root, dataset, args.tier, args.split)
    tasks = spec["tasks"]
    total = spec["total"]
    pool_path = spec["pool"]
    partition = spec["partition"]
    if not tasks or not jsonl_files(pool_path):
        raise SystemExit("Public benchmark tasks or skill pool is empty")

    phase_started = time.monotonic()
    dataset_hash = dataset_fingerprint(root, spec["files"])
    model_hash = model_fingerprint(models_root)
    fingerprint_seconds = time.monotonic() - phase_started
    expected = cache_metadata(dataset_hash, model_hash, partition, dataset)
    prefix = "" if dataset == "skillrouter" else f"{dataset}-"
    cache_root = Path(args.cache_dir).resolve() / f"{prefix}{partition}-{dataset_hash[:12]}-{model_hash[:12]}"
    cache_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(cache_root, 0o700)
    print(f"[setup] {dataset} {partition} · {len(tasks):,} tasks · {total or 'unknown'} skills · cache {cache_root}", flush=True)
    run_file = cache_root / "run.json"

    def update_run(status: str, phase: str) -> None:
        atomic_json(run_file, {
            **expected,
            "status": status,
            "phase": phase,
            "pid": os.getpid(),
            "dataset": dataset,
            "partition": partition,
            "dataRoot": str(root),
            "output": str(output),
            "tasks": len(tasks),
            "skills": total,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

    print("[phase 1/4] Loading the embedding checkpoint...", flush=True)
    update_run("running", "embedding")
    phase_started = time.monotonic()
    models = Models(str(models_root / "embedding"), str(models_root / "reranker"))
    batch_size = args.batch_size or automatic_batch_size(models.device)
    print(f"[setup] Device: {models.device} · embedding batch: {batch_size} · checkpoint: {args.checkpoint_every}", flush=True)
    query_vectors = embed_queries(models, tasks, batch_size, cache_root, expected)
    pool_state = embed_pool(models, pool_path, batch_size, args.checkpoint_every, cache_root, expected, total)
    embedding_seconds = time.monotonic() - phase_started

    print("[phase 2/4] Retrieving candidates from cached embedding shards...", flush=True)
    update_run("running", "retrieval")
    phase_started = time.monotonic()
    retrieval = retrieve(cache_root, pool_state, query_vectors, tasks, args.retrieval_k, expected)
    retrieval_seconds = time.monotonic() - phase_started

    print("[phase 3/4] Releasing the encoder before loading the reranker...", flush=True)
    update_run("running", "model-swap")
    models.unload_embedding()

    print("[phase 4/4] Reranking and checkpointing each task...", flush=True)
    update_run("running", "reranking")
    phase_started = time.monotonic()
    checkpoint = output.with_suffix(output.suffix + ".checkpoint.json")
    rerank(models, pool_path, tasks, retrieval, output, checkpoint, expected, args.retrieval_k)
    reranking_seconds = time.monotonic() - phase_started
    predictions = json.loads(output.read_text(encoding="utf-8"))
    print(f"[tokens] Estimating before/after skill context with top-{args.load_k} loading...", flush=True)
    token_usage = context_token_metrics(pool_path, predictions, args.load_k)
    update_run("complete", "complete")
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else None
    peak_rss_mb = None if peak_rss is None else peak_rss / (1024 * 1024) if sys.platform == "darwin" else peak_rss / 1024
    total_seconds = time.monotonic() - evaluation_started
    atomic_json(output.with_suffix(output.suffix + ".metrics.json"), {
        "dataset": dataset,
        "partition": partition,
        "device": str(models.device),
        "tasks": len(tasks),
        "skills": total,
        "embeddingBatchSize": batch_size,
        "retrievalK": args.retrieval_k,
        "fingerprintSeconds": fingerprint_seconds,
        "embeddingSeconds": embedding_seconds,
        "retrievalSeconds": retrieval_seconds,
        "rerankingSeconds": reranking_seconds,
        "totalSeconds": total_seconds,
        "amortizedSecondsPerQuery": total_seconds / len(tasks),
        "peakRssMb": peak_rss_mb,
        "cacheDir": str(cache_root),
        "contextTokens": token_usage,
    })
    print(f"[done] Saved predictions to {output}", flush=True)


if __name__ == "__main__":
    main()
