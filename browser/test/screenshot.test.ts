import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { writeScreenshot } from '../src/screenshot.ts'

const bases: string[] = []

afterEach(async () => {
  while (bases.length > 0) {
    const base = bases.pop()
    if (base !== undefined) await rm(base, { recursive: true, force: true })
  }
})

describe('writeScreenshot', () => {
  it('creates a missing nested directory and writes the file', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-shot-'))
    bases.push(base)
    const dir = join(base, 'nested', 'deeper') // does not exist yet
    const path = await writeScreenshot(Buffer.from('png-bytes'), dir)
    expect(path.startsWith(`${dir}/`)).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    const st = await stat(path)
    expect(st.size).toBe(Buffer.byteLength('png-bytes'))
  })

  it('uses a unique file name per call', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-shot-'))
    bases.push(base)
    const first = await writeScreenshot(Buffer.from('a'), base)
    const second = await writeScreenshot(Buffer.from('b'), base)
    expect(first).not.toBe(second)
  })

  it('is idempotent when the directory already exists', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-shot-'))
    bases.push(base)
    const first = await writeScreenshot(Buffer.from('a'), base)
    const second = await writeScreenshot(Buffer.from('b'), base)
    expect(first).not.toBe(second)
    expect((await stat(first)).size).toBe(1)
    expect((await stat(second)).size).toBe(1)
  })
})
