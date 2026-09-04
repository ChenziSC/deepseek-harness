import { describe, expect, it } from 'vitest'
import {
  BGE_DENSE_DTYPE,
  BGE_QUERY_PREFIX,
  BGE_SMALL_EN_MODEL_ID,
  BGE_SMALL_EN_REVISION,
  DENSE_DIMENSIONS,
  DenseEncoder,
  loadDenseEncoder,
  type DenseFeatureExtractionOptions,
  type DenseFeatureExtractor,
} from '@deepseek-ai/dsh-experimental-knowledge-local'

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
      modelId: BGE_SMALL_EN_MODEL_ID,
      revision: BGE_SMALL_EN_REVISION,
      dtype: BGE_DENSE_DTYPE,
      maxTokens: 512,
    })
  })
})

const modelCacheDir = process.env['DSH_BGE_MODEL_CACHE_DIR']

describe.skipIf(modelCacheDir === undefined)('Dense local model smoke', () => {
  it('embeds one document batch and one query without network access', async () => {
    if (modelCacheDir === undefined) throw new TypeError('DSH_BGE_MODEL_CACHE_DIR is required')
    const encoder = await loadDenseEncoder({ cacheDir: modelCacheDir, localFilesOnly: true })
    try {
      await expect(encoder.embedDocuments(['Science\nEvidence supports the claim.']))
        .resolves.toHaveLength(DENSE_DIMENSIONS)
      await expect(encoder.embedQuery('What supports the claim?')).resolves.toHaveLength(DENSE_DIMENSIONS)
    } finally {
      await encoder.dispose()
    }
  })
})
