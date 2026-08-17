// In-process embedding backend: a small sentence-transformer that runs inside Node via
// onnxruntime, with no Ollama, no Python service, and no GPU. It makes "embeddings on by
// default" real for a fresh install — the strong routing path works without the user
// standing up a separate backend first. Quality sits between the lexical fallback and the
// 0.6B SkillRouter encoder; see the README backend comparison.
//
// The model is loaded lazily and cached for the process. It is only imported when this
// backend is actually selected, so the heavy onnxruntime dependency never loads for users
// on Ollama or the SkillRouter service.

import os from 'node:os';
import path from 'node:path';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

// transformers.js otherwise caches the model inside its own node_modules/.cache, which is
// per-install and, under npx, a throwaway directory — so the ~90 MB model re-downloads on
// every run and any network hiccup fails the whole route. Pin it to a stable, shared
// location so it downloads once and every invocation (npx, global, or local) reuses it.
function modelCacheDir() {
  return process.env.SKILLRAM_MODEL_CACHE
    ?? path.join(process.env.SKILLRAM_HOME ?? path.join(os.homedir(), '.skillram'), 'models', 'transformers');
}

let pipelinePromise = null;

async function loadTransformers() {
  // Ships as an optionalDependency, so it is normally installed automatically. If it failed
  // to build on this platform, fail with a clear instruction rather than a raw import error;
  // the router catches this and degrades to lexical matching.
  try {
    return await import('@huggingface/transformers');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package/.test(error?.message ?? '')) {
      throw new Error('The default in-process embedding backend needs @huggingface/transformers. Reinstall it with `npm install @huggingface/transformers`, or use --router skillrouter (the local model service) or a custom SKILLRAM_EMBEDDING_URL instead.');
    }
    throw error;
  }
}

async function getExtractor(model) {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await loadTransformers();
      // Persistent, shared cache so the model downloads exactly once across all invocations.
      env.cacheDir = modelCacheDir();
      env.allowRemoteModels = env.allowRemoteModels ?? true;
      return pipeline('feature-extraction', model ?? DEFAULT_MODEL);
    })().catch((error) => {
      pipelinePromise = null; // allow a later retry rather than caching the failure
      throw error;
    });
  }
  return pipelinePromise;
}

// Returns one plain number[] per input text. Mean-pooled and L2-normalized, so cosine
// similarity is a dot product — matching how the router compares vectors.
export async function embedLocal(texts, { model = DEFAULT_MODEL } = {}) {
  if (!texts.length) return [];
  const extractor = await getExtractor(model);
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const [rows, dim] = output.dims;
  const flat = output.data;
  const vectors = [];
  for (let row = 0; row < rows; row += 1) {
    vectors.push(Array.from(flat.slice(row * dim, (row + 1) * dim)));
  }
  return vectors;
}

export function localEmbedderModel(options = {}) {
  return options.embeddingModel ?? process.env.SKILLRAM_LOCAL_EMBED_MODEL ?? DEFAULT_MODEL;
}

// The in-process backend is selected explicitly, never as a silent default, because it adds
// the onnxruntime dependency. `minilm` and `local` are both accepted spellings.
export function usesLocalEmbedder(options = {}) {
  const backend = options.embeddingBackend ?? process.env.SKILLRAM_EMBEDDING_BACKEND ?? null;
  return backend === 'minilm' || backend === 'local';
}
