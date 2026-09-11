import { describe, expect, it, vi } from 'vitest'

const transformerMocks = vi.hoisted(() => {
  const tokenizer = vi.fn(() => ({}))
  const dispose = vi.fn(() => Promise.resolve())
  const featureExtractor = Object.assign(vi.fn(), { tokenizer, dispose })
  return {
    tokenizer,
    dispose,
    featureExtractor,
    pipeline: vi.fn(() => Promise.resolve(featureExtractor)),
  }
})

vi.mock('@huggingface/transformers', () => ({ pipeline: transformerMocks.pipeline }))
import { DENSE_DIMENSIONS } from '../src/dense.ts'
import {
  BGE_DENSE_DTYPE,
  BGE_QUERY_PREFIX,
  DenseEncoder,
  loadDenseEncoder,
  type DenseFeatureExtractionOptions,
  type DenseFeatureExtractor,
} from '../src/model-runtime.ts'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION } from '../src/tokenizer.ts'

function normalizedRows(rowCount: number): Float32Array {
  const vectors = new Float32Array(rowCount * DENSE_DIMENSIONS)
  for (let row = 0; row < rowCount; row += 1) vectors[row * DENSE_DIMENSIONS] = 1
  return vectors
}

function extractor(
  calls: Array<{ texts: readonly string[]; options: DenseFeatureExtractionOptions }>,
): DenseFeatureExtractor {
  return {
    extract: (texts, options) => {
      calls.push({ texts: [...texts], options })
      return Promise.resolve({
        type: 'float32',
        dims: [texts.length, DENSE_DIMENSIONS],
        data: normalizedRows(texts.length),
      })
    },
    dispose: () => Promise.resolve(),
  }
}

describe('DenseEncoder', () => {
  it('keeps document starts, prefixes queries, and requests fixed inference behavior', async () => {
    const calls: Array<{ texts: readonly string[]; options: DenseFeatureExtractionOptions }> = []
    const encoder = new DenseEncoder(extractor(calls), 37)

    await encoder.embedDocuments(['Title\nbody tail'])
    const query = await encoder.embedQuery('claim text')

    expect(calls).toEqual([
      {
        texts: ['Title\nbody tail'],
        options: { pooling: 'cls', normalize: true, truncation: true, maxLength: 37 },
      },
      {
        texts: [`${BGE_QUERY_PREFIX}claim text`],
        options: { pooling: 'cls', normalize: true, truncation: true, maxLength: 37 },
      },
    ])
    expect(query).toHaveLength(DENSE_DIMENSIONS)
  })

  it('rejects the wrong type, dimensions, non-finite values, and unnormalized rows', async () => {
    const cases = [
      { type: 'float64', dims: [1, DENSE_DIMENSIONS], data: normalizedRows(1) },
      { type: 'float32', dims: [1, DENSE_DIMENSIONS - 1], data: new Float32Array(DENSE_DIMENSIONS - 1) },
      { type: 'float32', dims: [1, DENSE_DIMENSIONS], data: [] },
      { type: 'float32', dims: [1, DENSE_DIMENSIONS], data: new Float32Array(DENSE_DIMENSIONS).fill(Number.NaN) },
      { type: 'float32', dims: [1, DENSE_DIMENSIONS], data: new Float32Array(DENSE_DIMENSIONS) },
    ]
    for (const output of cases) {
      const encoder = new DenseEncoder({
        extract: () => Promise.resolve(output),
        dispose: () => Promise.resolve(),
      }, 512)
      await expect(encoder.embedQuery('claim')).rejects.toThrow()
    }
  })

  it('passes an explicit local-only model identity to the loader', async () => {
    let received: Parameters<NonNullable<Parameters<typeof loadDenseEncoder>[1]>>[0] | undefined
    await loadDenseEncoder({
      cacheDir: '/model-cache',
      localFilesOnly: true,
    }, (options) => {
      received = options
      return Promise.resolve(extractor([]))
    })

    expect(received).toEqual({
      cacheDir: '/model-cache',
      localFilesOnly: true,
      modelId: BGE_M3_MODEL_ID,
      revision: BGE_M3_REVISION,
      dtype: BGE_DENSE_DTYPE,
      maxTokens: 512,
      dimensions: DENSE_DIMENSIONS,
      queryPrefix: '',
      modelFile: 'onnx/model_quantized.onnx',
    })
  })

  it.each([
    [{ cacheDir: ' ' }, 'dense cacheDir must be non-empty'],
    [{ cacheDir: '/cache', modelId: ' ' }, 'dense modelId must be non-empty'],
    [{ cacheDir: '/cache', revision: 'main' }, 'dense revision must be a full lowercase commit SHA'],
    [{ cacheDir: '/cache', maxTokens: 0 }, 'dense maxTokens must be an integer from 1 through 8192'],
    [{ cacheDir: '/cache', maxTokens: 8193 }, 'dense maxTokens must be an integer from 1 through 8192'],
    [{ cacheDir: '/cache', maxTokens: 1.5 }, 'dense maxTokens must be an integer from 1 through 8192'],
    [{ cacheDir: '/cache', dimensions: 0 }, 'dense dimensions must be a positive safe integer'],
    [{ cacheDir: '/cache', dimensions: 1.5 }, 'dense dimensions must be a positive safe integer'],
    [{ cacheDir: '/cache', modelFile: 'other.onnx' }, 'dense modelFile is unsupported'],
  ])('rejects invalid loader options %j', async (override, message) => {
    await expect(loadDenseEncoder({ localFilesOnly: true, ...override })).rejects.toThrow(message)
  })

  it('returns an empty matrix without invoking the extractor and disposes it', async () => {
    const calls: Array<{ texts: readonly string[]; options: DenseFeatureExtractionOptions }> = []
    const backend = extractor(calls)
    const encoder = new DenseEncoder(backend, 512)
    await expect(encoder.embedDocuments([])).resolves.toEqual(new Float32Array())
    expect(calls).toEqual([])
    await encoder.dispose()
  })

  it('uses the Transformers.js adapter with forced tokenizer truncation', async () => {
    transformerMocks.featureExtractor.mockResolvedValue({
      type: 'float32',
      dims: [1, DENSE_DIMENSIONS],
      data: normalizedRows(1),
    })
    const encoder = await loadDenseEncoder({
      cacheDir: '/cache',
      localFilesOnly: true,
      modelId: 'model',
      revision: 'a'.repeat(40),
      dtype: 'q8',
      maxTokens: 64,
    })
    await encoder.embedDocuments(['body'])
    const wrappedTokenizer = transformerMocks.featureExtractor.tokenizer as unknown as (
      texts: string,
      options?: unknown,
    ) => unknown
    wrappedTokenizer('text', { padding: true })
    wrappedTokenizer('text')
    expect(transformerMocks.tokenizer).toHaveBeenCalledWith('text', {
      padding: true,
      truncation: true,
      max_length: 64,
    })
    expect(transformerMocks.tokenizer).toHaveBeenLastCalledWith('text', {
      truncation: true,
      max_length: 64,
    })
    expect(transformerMocks.featureExtractor).toHaveBeenCalledWith(['body'], {
      pooling: 'cls',
      normalize: true,
    })
    await encoder.dispose()
    expect(transformerMocks.dispose).toHaveBeenCalled()
  })
})
