import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.ts'

function sink(): { output: string; write: (chunk: string | Uint8Array) => boolean } {
  const target = {
    output: '',
    write(chunk: string | Uint8Array): boolean {
      target.output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
  }
  return target
}

describe('dsh-knowledge CLI', () => {
  it('prints help successfully', async () => {
    const stdout = sink()
    const stderr = sink()
    await expect(runCli(['--help'], stdout, stderr)).resolves.toBe(0)
    expect(stdout.output).toContain('Usage: dsh-knowledge')
    expect(stderr.output).toBe('')
  })

  it('reports missing prepare and evaluate inputs without starting network or models', async () => {
    const stdout = sink()
    const stderr = sink()
    await expect(runCli(['evaluate'], stdout, stderr)).resolves.toBe(2)
    expect(stderr.output).toContain('--index is required')

    stderr.output = ''
    await expect(runCli(['prepare'], stdout, stderr)).resolves.toBe(2)
    expect(stderr.output).toContain('prepare requires one dataset name')
  })

  it('reports missing index options without loading a model', async () => {
    const stdout = sink()
    const stderr = sink()
    await expect(runCli(['index'], stdout, stderr)).resolves.toBe(2)
    expect(stderr.output).toContain('--corpus is required')
  })
})
