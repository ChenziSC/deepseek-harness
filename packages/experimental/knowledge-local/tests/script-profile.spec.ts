import { countTextScripts, profileTextScript, resolveTextScriptProfile } from '../src/script-profile.ts'
import { describe, expect, it } from 'vitest'

describe('text script profiling', () => {
  it('counts Latin and CJK letters without treating punctuation or digits as language', () => {
    expect(countTextScripts('API 123 中文かな한')).toEqual({ latin: 3, cjk: 5 })
    expect(profileTextScript('123_!?')).toBe('neutral')
  })

  it('uses the documented minority threshold for mixed text', () => {
    expect(resolveTextScriptProfile({ latin: 8, cjk: 2 })).toBe('mixed')
    expect(resolveTextScriptProfile({ latin: 9, cjk: 1 })).toBe('latin')
    expect(resolveTextScriptProfile({ latin: 1, cjk: 9 })).toBe('cjk')
  })
})
