import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import LocalKnowledge, * as entrypoint from '../src/index.ts'

const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

async function relativeDependencies(path: string): Promise<string[]> {
  const source = await readFile(path, 'utf8')
  return [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)]
    .map(match => resolve(dirname(path), match[1] as string))
}

async function productionGraph(entrypoints: readonly string[]): Promise<Set<string>> {
  const visited = new Set<string>()
  const pending = entrypoints.map(entrypoint => resolve(sourceDirectory, entrypoint))
  while (pending.length > 0) {
    const path = pending.pop() as string
    if (visited.has(path)) continue
    visited.add(path)
    pending.push(...await relativeDependencies(path))
  }
  return visited
}

describe('package entrypoint', () => {
  it('exports only the Loader plugin and its configuration', () => {
    expect(Object.keys(entrypoint).sort()).toEqual(['Config', 'LocalKnowledge', 'default'])
    expect(entrypoint.default).toBe(LocalKnowledge)
    expect(entrypoint.LocalKnowledge).toBe(LocalKnowledge)
  })

  it('keeps provider, index construction, and product CLI commands independent of offline experiments', async () => {
    const graph = await productionGraph(['index.ts', 'index-builder.ts', 'cli/index.ts', 'cli/derive.ts'])
    expect([...graph].filter(path => path.includes('/offline/'))).toEqual([])
  })
})
