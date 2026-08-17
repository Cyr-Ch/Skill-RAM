from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download


def main() -> None:
    parser = argparse.ArgumentParser(description="Download SkillRouter models into SkillRAM's private state directory.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--embedding-model", default="pipizhao/SkillRouter-Embedding-0.6B")
    parser.add_argument("--reranker-model", default="pipizhao/SkillRouter-Reranker-0.6B")
    args = parser.parse_args()

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    api = HfApi()
    embedding_revision = api.model_info(args.embedding_model).sha
    reranker_revision = api.model_info(args.reranker_model).sha
    snapshot_download(args.embedding_model, revision=embedding_revision, local_dir=output / "embedding")
    snapshot_download(args.reranker_model, revision=reranker_revision, local_dir=output / "reranker")
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "embedding": {"repo": args.embedding_model, "revision": embedding_revision},
        "reranker": {"repo": args.reranker_model, "revision": reranker_revision},
        "packages": {name: version(name) for name in ["torch", "transformers", "accelerate", "huggingface-hub", "sentencepiece", "safetensors"]},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
