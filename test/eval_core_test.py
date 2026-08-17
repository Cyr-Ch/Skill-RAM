from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "service"))

from eval_core import (  # noqa: E402
    automatic_batch_size,
    cache_metadata,
    context_token_metrics,
    dataset_spec,
    detect_dataset,
    embed_pool,
    embed_queries,
    rerank,
    retrieve,
)
from sample_eval_core import jsonl as sample_jsonl, write_sample  # noqa: E402


class FakeModels:
    def __init__(self) -> None:
        self.embed_calls = 0

    def embed_tensor(self, texts: list[str], input_type: str) -> torch.Tensor:
        self.embed_calls += 1
        return torch.tensor([
            [1.0, 0.0] if "alpha" in text.lower() else [0.0, 1.0]
            for text in texts
        ])

    def rerank(self, prompt: str, candidates: list[dict]) -> list[dict]:
        return [{"id": candidate["id"], "score": 1.0} for candidate in candidates]


class EvalCoreTest(unittest.TestCase):
    def test_streams_caches_retrieves_and_resumes_predictions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pool = root / "easy"
            cache = root / "cache"
            pool.mkdir()
            cache.mkdir()
            (pool / "pool.jsonl").write_text(
                '\n'.join([
                    json.dumps({"skill_id": "alpha-skill", "name": "Alpha", "description": "alpha work", "body": "alpha steps"}),
                    json.dumps({"skill_id": "beta-skill", "name": "Beta", "description": "beta work", "body": "beta steps"}),
                ]) + '\n',
                encoding="utf-8",
            )
            tasks = [
                {"task_id": "task-alpha", "instruction_text": "do alpha work"},
                {"task_id": "task-beta", "instruction_text": "do beta work"},
            ]
            expected = cache_metadata("dataset", "model", "easy")
            models = FakeModels()
            queries = embed_queries(models, tasks, 1, cache, expected)
            state = embed_pool(models, pool, 1, 1, cache, expected, 2)
            calls_after_first_run = models.embed_calls

            cached_queries = embed_queries(models, tasks, 1, cache, expected)
            cached_state = embed_pool(models, pool, 1, 1, cache, expected, 2)
            self.assertEqual(models.embed_calls, calls_after_first_run)
            self.assertTrue(torch.equal(queries, cached_queries))
            self.assertEqual(cached_state["completed"], 2)

            candidates = retrieve(cache, state, queries, tasks, 1, expected)
            self.assertEqual(candidates["task-alpha"][0]["id"], "alpha-skill")
            self.assertEqual(candidates["task-beta"][0]["id"], "beta-skill")

            output = root / "predictions.json"
            checkpoint = root / "predictions.checkpoint.json"
            rerank(models, pool, tasks, candidates, output, checkpoint, expected, 1)
            first_predictions = output.read_text(encoding="utf-8")
            rerank(models, pool, tasks, candidates, output, checkpoint, expected, 1)
            self.assertEqual(output.read_text(encoding="utf-8"), first_predictions)

    def test_uses_conservative_automatic_batches(self) -> None:
        self.assertEqual(automatic_batch_size(torch.device("mps")), 2)
        self.assertEqual(automatic_batch_size(torch.device("cpu")), 2)
        self.assertEqual(automatic_batch_size(torch.device("cuda")), 16)

    def test_adapts_skillret_jsonl_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for kind in ("skills", "queries", "qrels"):
                (root / "data" / kind).mkdir(parents=True)
            (root / "data" / "skills" / "test.jsonl").write_text(
                json.dumps({"id": "skill-a", "name": "A", "description": "alpha", "skill_md": "alpha body"}) + "\n",
                encoding="utf-8",
            )
            (root / "data" / "queries" / "test.jsonl").write_text(
                json.dumps({"id": "query-a", "query": "do alpha", "skill_ids": ["skill-a"]}) + "\n",
                encoding="utf-8",
            )
            (root / "data" / "qrels" / "test.jsonl").write_text(
                json.dumps({"query_id": "query-a", "skill_id": "skill-a", "relevance": 1}) + "\n",
                encoding="utf-8",
            )
            self.assertEqual(detect_dataset(root, "auto"), "skillret")
            spec = dataset_spec(root, "skillret", "easy", "test")
            self.assertEqual(spec["total"], 1)
            self.assertEqual(spec["tasks"][0]["task_id"], "query-a")

    def test_builds_bounded_sample_with_every_graded_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            output = Path(temporary) / "sample"
            (root / "easy").mkdir(parents=True)
            tasks = [
                {"task_id": "one", "instruction_text": "review alpha code"},
                {"task_id": "two", "instruction_text": "deploy beta service"},
            ]
            (root / "tasks.jsonl").write_text("".join(json.dumps(item) + "\n" for item in tasks), encoding="utf-8")
            relevance = {
                "one": {"task_type": "clean", "core_gt_ids": ["gold-a"], "relevance": {"gold-a": 3, "degraded-a": 1}},
                "two": {"task_type": "mixed", "core_gt_ids": ["gold-b"], "relevance": {"gold-b": 3}},
            }
            (root / "relevance.json").write_text(json.dumps(relevance), encoding="utf-8")
            skills = [
                {"skill_id": "noise-1", "name": "Review helper", "description": "review alpha", "body": "noise"},
                {"skill_id": "gold-a", "name": "Alpha", "description": "alpha", "body": "gold body"},
                {"skill_id": "degraded-a", "name": "Alpha partial", "description": "alpha", "body": "partial"},
                {"skill_id": "noise-2", "name": "Deploy helper", "description": "deploy beta", "body": "noise"},
                {"skill_id": "gold-b", "name": "Beta", "description": "beta", "body": "gold body"},
                {"skill_id": "noise-3", "name": "Other", "description": "unrelated", "body": "noise"},
            ]
            (root / "easy" / "pool.jsonl").write_text("".join(json.dumps(item) + "\n" for item in skills), encoding="utf-8")
            manifest = write_sample(root, output, "easy", 2, 5, "fixture")
            sampled_ids = {item["skill_id"] for item in sample_jsonl(output / "easy")}
            self.assertTrue({"gold-a", "degraded-a", "gold-b"}.issubset(sampled_ids))
            self.assertEqual(manifest["sampleStats"]["selectedSkills"], 5)

    def test_estimates_context_tokens_from_ranked_loads(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            pool = Path(temporary) / "pool.jsonl"
            pool.write_text("\n".join([
                json.dumps({"skill_id": "a", "name": "Alpha", "description": "alpha helper", "body": "alpha full instructions"}),
                json.dumps({"skill_id": "b", "name": "Beta", "description": "beta helper", "body": "beta full instructions"}),
            ]) + "\n", encoding="utf-8")
            metrics = context_token_metrics(pool, {"q1": ["a", "b"], "q2": ["b", "a"]}, 1)
            self.assertEqual(metrics["loadK"], 1)
            self.assertEqual(metrics["queries"], 2)
            self.assertGreater(metrics["baselineCatalogTokensAcrossQueries"], 0)
            self.assertGreater(metrics["loadedInstructionTokensAcrossQueries"], 0)


if __name__ == "__main__":
    unittest.main()
