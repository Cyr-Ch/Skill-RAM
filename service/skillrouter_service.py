from __future__ import annotations

import argparse
import gc
import json
import math
import os
import re
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn, UnixStreamServer
from typing import Any

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoModelForCausalLM, AutoTokenizer

QUERY_INSTRUCTION = (
    "Instruct: Given a coding task description, retrieve the most relevant "
    "skill document that would help an agent complete the task\nQuery:"
)
RERANK_INSTRUCTION = (
    "Given a coding task description, judge whether the skill document "
    "is relevant and useful for completing the task"
)


def device_and_dtype() -> tuple[torch.device, torch.dtype]:
    if torch.cuda.is_available():
        return torch.device("cuda"), torch.bfloat16
    if torch.backends.mps.is_available():
        return torch.device("mps"), torch.float16
    return torch.device("cpu"), torch.float32


def last_token_pool(hidden: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    # Both tokenizers use left padding, so each non-empty sequence ends at the
    # final position. Avoiding a scalar tensor check also removes an extra MPS
    # command-buffer synchronization from every embedding batch.
    return hidden[:, -1]


class Models:
    def __init__(self, embedding_path: str, reranker_path: str) -> None:
        self.embedding_path = embedding_path
        self.reranker_path = reranker_path
        self.device, self.dtype = device_and_dtype()
        self.embedding_model = None
        self.embedding_tokenizer = None
        self.reranker_model = None
        self.reranker_tokenizer = None
        self.embedding_lock = threading.RLock()
        self.reranker_lock = threading.RLock()
        # Default 4 preserves the previous throughput; lower it on memory-constrained
        # accelerators via SKILLRAM_RERANK_BATCH to avoid fragmentation OOMs on long runs.
        try:
            self.rerank_batch_size = max(1, int(os.environ.get("SKILLRAM_RERANK_BATCH", "4")))
        except ValueError:
            self.rerank_batch_size = 4

    def release_cache(self) -> None:
        # Return freed accelerator memory to the allocator so it does not fragment across a
        # long evaluation. Guarded per backend; a no-op on CPU.
        if self.device == "mps" and hasattr(torch, "mps"):
            torch.mps.empty_cache()
        elif self.device == "cuda":
            torch.cuda.empty_cache()

    def load_embedding(self) -> None:
        if self.embedding_model is not None:
            return
        self.embedding_tokenizer = AutoTokenizer.from_pretrained(
            self.embedding_path, trust_remote_code=True, padding_side="left"
        )
        self.embedding_model = AutoModel.from_pretrained(
            self.embedding_path, trust_remote_code=True, dtype=self.dtype
        ).to(self.device).eval()
        if self.embedding_tokenizer.pad_token is None:
            self.embedding_tokenizer.pad_token = self.embedding_tokenizer.eos_token

    def load_reranker(self) -> None:
        if self.reranker_model is not None:
            return
        self.reranker_tokenizer = AutoTokenizer.from_pretrained(
            self.reranker_path, trust_remote_code=True, padding_side="left"
        )
        self.reranker_model = AutoModelForCausalLM.from_pretrained(
            self.reranker_path, trust_remote_code=True, dtype=self.dtype
        ).to(self.device).eval()
        if self.reranker_tokenizer.pad_token is None:
            self.reranker_tokenizer.pad_token = self.reranker_tokenizer.eos_token

    def unload_embedding(self) -> None:
        with self.embedding_lock:
            self.embedding_model = None
            self.embedding_tokenizer = None
        gc.collect()
        if self.device.type == "cuda":
            torch.cuda.empty_cache()
        elif self.device.type == "mps":
            torch.mps.empty_cache()

    def embed(self, texts: list[str], input_type: str) -> list[list[float]]:
        return self.embed_tensor(texts, input_type).tolist()

    def embed_tensor(self, texts: list[str], input_type: str) -> torch.Tensor:
        with self.embedding_lock:
            self.load_embedding()
            assert self.embedding_model is not None and self.embedding_tokenizer is not None
            if input_type == "query":
                texts = [f"{QUERY_INSTRUCTION}{text[:2000]}" for text in texts]
            encoded = self.embedding_tokenizer(
                texts, padding=True, truncation=True, max_length=4096, return_tensors="pt"
            )
            encoded = {key: value.to(self.device) for key, value in encoded.items()}
            with torch.no_grad():
                output = self.embedding_model(**encoded)
                vectors = last_token_pool(output.last_hidden_state, encoded["attention_mask"])
                vectors = F.normalize(vectors, p=2, dim=1).float().cpu()
            return vectors

    def rerank(self, prompt: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        with self.reranker_lock:
            return self._rerank_locked(prompt, candidates)

    def _rerank_locked(self, prompt: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        self.load_reranker()
        assert self.reranker_model is not None and self.reranker_tokenizer is not None
        tokenizer = self.reranker_tokenizer
        prefix = (
            '<|im_start|>system\nJudge whether the Document meets the requirements '
            'based on the Query and the Instruct provided. Note that the answer can '
            'only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
        )
        suffix = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
        prefix_tokens = tokenizer.encode(prefix, add_special_tokens=False)
        suffix_tokens = tokenizer.encode(suffix, add_special_tokens=False)
        yes_id = tokenizer.convert_tokens_to_ids("yes")
        no_id = tokenizer.convert_tokens_to_ids("no")
        tokenized: list[tuple[str, list[int]]] = []
        for candidate in candidates:
            document = f"{candidate.get('name', '')} | {candidate.get('description', '')[:500]} | {candidate.get('body', '')[:8000]}"
            text = (
                f"<Instruct>: {RERANK_INSTRUCTION}\n\n<Query>: {prompt[:2000]}"
                f"\n\n<Document>: {document}"
            )
            body_tokens = tokenizer(
                text, truncation=True, max_length=4096 - len(prefix_tokens) - len(suffix_tokens),
                return_attention_mask=False
            )["input_ids"]
            tokenized.append((candidate["id"], prefix_tokens + body_tokens + suffix_tokens))
        scored: list[dict[str, Any]] = []
        pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else 0
        # A batch of long candidates produces a large activation tensor, and MPS does not
        # return freed memory to its pool between allocations, so fragmentation builds over a
        # long evaluation until one allocation exceeds the ceiling. Smaller batches on
        # constrained unified memory trade a little speed for not dying at task 25 of 75.
        for offset in range(0, len(tokenized), self.rerank_batch_size):
            batch = tokenized[offset:offset + self.rerank_batch_size]
            max_length = max(len(tokens) for _, tokens in batch)
            padded = [[pad_id] * (max_length - len(tokens)) + tokens for _, tokens in batch]
            masks = [[0] * (max_length - len(tokens)) + [1] * len(tokens) for _, tokens in batch]
            input_ids = torch.tensor(padded, device=self.device)
            attention_mask = torch.tensor(masks, device=self.device)
            with torch.no_grad():
                logits = self.reranker_model(input_ids=input_ids, attention_mask=attention_mask).logits[:, -1]
            raw_scores = (logits[:, yes_id] - logits[:, no_id]).float().cpu().tolist()
            for (candidate_id, _), raw in zip(batch, raw_scores):
                scored.append({"id": candidate_id, "score": 1.0 / (1.0 + math.exp(-max(-30, min(30, raw))))})
            del input_ids, attention_mask, logits
        self.release_cache()
        return sorted(scored, key=lambda item: (-item["score"], item["id"]))


class Handler(BaseHTTPRequestHandler):
    models: Models

    def log_message(self, format: str, *args: Any) -> None:
        # Do not print request bodies or prompts.
        super().log_message(format, *args)

    def address_string(self) -> str:
        return "local"

    def reply(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        status, body = dispatch(self.models, self.path, "GET", None)
        self.reply(status, body)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 64 * 1024 * 1024:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length))
            status, body = dispatch(self.models, self.path, "POST", payload)
            self.reply(status, body)
        except Exception as error:  # Return an actionable error without echoing private input.
            self.reply(400, {"error": type(error).__name__, "message": str(error)[:500]})


def dispatch(models: Models, request_path: str, method: str, payload: Any) -> tuple[int, dict[str, Any]]:
    if request_path == "/health" and method == "GET":
        return 200, {
            "ok": True,
            "service": "skillram-skillrouter",
            "protocol": 2,
            "device": str(models.device),
            "embeddingLoaded": models.embedding_model is not None,
            "rerankerLoaded": models.reranker_model is not None,
        }
    if request_path == "/embed" and method == "POST":
        texts = payload.get("input") if isinstance(payload, dict) else None
        if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
            raise ValueError("input must be a string array")
        return 200, {"embeddings": models.embed(texts, payload.get("input_type", "document"))}
    if request_path == "/rerank" and method == "POST":
        prompt = payload.get("prompt") if isinstance(payload, dict) else None
        candidates = payload.get("candidates") if isinstance(payload, dict) else None
        if not isinstance(prompt, str) or not isinstance(candidates, list):
            raise ValueError("prompt and candidates are required")
        return 200, {"ranked": models.rerank(prompt, candidates)}
    return 404, {"error": "not found"}


def serve_file_ipc(models: Models, ipc_root: Path, stopped: threading.Event) -> None:
    requests = ipc_root / "requests"
    responses = ipc_root / "responses"
    requests.mkdir(parents=True, exist_ok=True, mode=0o700)
    responses.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(ipc_root, 0o700)
    os.chmod(requests, 0o700)
    os.chmod(responses, 0o700)
    while not stopped.is_set():
        handled = False
        for request_file in requests.glob("*.json"):
            handled = True
            if not re.fullmatch(r"[0-9a-f-]{36}\.json", request_file.name):
                continue
            request_id = request_file.stem
            try:
                envelope = json.loads(request_file.read_text(encoding="utf-8"))
                if envelope.get("version") != 1 or envelope.get("id") != request_id:
                    raise ValueError("invalid IPC request envelope")
                status, body = dispatch(models, envelope.get("path", ""), envelope.get("method", "GET"), envelope.get("body"))
            except Exception as error:
                status, body = 400, {"error": type(error).__name__, "message": str(error)[:500]}
            finally:
                request_file.unlink(missing_ok=True)
            response_file = responses / f"{request_id}.json"
            temporary = responses / f".{request_id}.{os.getpid()}.tmp"
            temporary.write_text(json.dumps({"id": request_id, "status": status, "body": body}) + "\n", encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, response_file)
        if not handled:
            stopped.wait(0.02)


class ThreadingUnixHTTPServer(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, socket_path: str, handler) -> None:
        self.server_name = "localhost"
        self.server_port = 0
        super().__init__(socket_path, handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Local SkillRouter-compatible inference service for SkillRAM.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--models", required=True)
    parser.add_argument("--socket")
    parser.add_argument("--ipc")
    parser.add_argument("--lazy", action="store_true", help="Load checkpoints on the first request instead of before listening.")
    args = parser.parse_args()
    model_root = Path(args.models)
    Handler.models = Models(str(model_root / "embedding"), str(model_root / "reranker"))
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    unix_server = None
    if args.socket:
        socket_path = Path(args.socket)
        socket_path.parent.mkdir(parents=True, exist_ok=True)
        if socket_path.exists():
            metadata = socket_path.stat()
            if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != os.getuid():
                server.server_close()
                raise RuntimeError(f"Refusing to replace unsafe socket path: {socket_path}")
            socket_path.unlink()
        unix_server = ThreadingUnixHTTPServer(str(socket_path), Handler)
        os.chmod(socket_path, 0o600)
    if not args.lazy:
        print("Loading SkillRouter embedding and reranker checkpoints...", flush=True)
        try:
            Handler.models.load_embedding()
            Handler.models.load_reranker()
        except Exception:
            server.server_close()
            if unix_server:
                unix_server.server_close()
                Path(args.socket).unlink(missing_ok=True)
            raise
    ipc_stopped = threading.Event()
    if args.ipc:
        ipc_root = Path(args.ipc)
        ipc_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        threading.Thread(target=serve_file_ipc, args=(Handler.models, ipc_root, ipc_stopped), daemon=True).start()
    if unix_server:
        threading.Thread(target=unix_server.serve_forever, daemon=True).start()
    transports = [f"http://{args.host}:{args.port}"]
    if args.socket:
        transports.append(args.socket)
    if args.ipc:
        transports.append(f"file-ipc:{args.ipc}")
    print("SkillRAM model service listening on " + " and ".join(transports), flush=True)
    try:
        server.serve_forever()
    finally:
        ipc_stopped.set()
        server.server_close()
        if unix_server:
            unix_server.shutdown()
            unix_server.server_close()
            Path(args.socket).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
