import { fileURLToPath } from 'node:url'
import { MONGODB_URI } from '@canopy/testing'
import { describe, expect, it } from 'vitest'
import { parseArgs, run } from '../src/cli.ts'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

function capture(): {
  lines: string[]
  errors: string[]
  out: { log(line: string): void; error(line: string): void }
} {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
  }
}

describe('canopy cli', () => {
  it('parses flags', () => {
    const { positional, flags } = parseArgs([
      'policies',
      'lint',
      '--dir',
      'x',
      '--mongodb-uri=mongodb://h',
      '--help',
    ])
    expect(positional).toEqual(['policies', 'lint'])
    expect(flags.get('dir')).toBe('x')
    expect(flags.get('mongodb-uri')).toBe('mongodb://h')
    expect(flags.get('help')).toBe(true)
  })

  it('lints clean policies with exit code 0', async () => {
    const { lines, errors, out } = capture()
    expect(await run(['policies', 'lint', '--dir', fixture('good')], {}, out)).toBe(0)
    expect(errors).toEqual([])
    expect(lines.at(-1)).toMatch(/^1 collections, \d+ findings, 0 errors$/)
  })

  it('fails lint on dangerous policies and names the rules', async () => {
    const { errors, out } = capture()
    expect(await run(['policies', 'lint', '--dir', fixture('bad')], {}, out)).toBe(1)
    expect(errors.join('\n')).toContain('public-allow-all')
    expect(errors.join('\n')).toContain('user-editable-claim')
  })

  it('runs policy tests in memory', async () => {
    const { lines, errors, out } = capture()
    const code = await run(['policies', 'test', '--dir', fixture('good')], {}, out)
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(lines.some((line) => line.startsWith('coverage  todos: 5/5'))).toBe(true)
    expect(lines.at(-1)).toBe('11 cases on memory, 0 failed')
  })

  it('shows usage for unknown commands', async () => {
    const { errors, out } = capture()
    expect(await run(['frobnicate'], {}, out)).toBe(1)
    expect(errors[0]).toContain('Unknown command')
  })

  const withMongo = MONGODB_URI === undefined ? it.skip : it

  withMongo('runs policy tests against MongoDB too, and the two backends agree', async () => {
    const { lines, errors, out } = capture()
    const code = await run(
      ['policies', 'test', '--dir', fixture('good'), '--mongodb-uri', MONGODB_URI ?? ''],
      {},
      out,
    )
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(lines.at(-1)).toBe('11 cases on memory and mongodb, 0 failed')
  })

  withMongo('doctor reports a healthy replica set', async () => {
    const { lines, errors, out } = capture()
    const code = await run(
      [
        'doctor',
        '--mongodb-uri',
        MONGODB_URI ?? '',
        '--database',
        'canopy_doctor',
        '--dir',
        fixture('good'),
      ],
      {},
      out,
    )
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(lines.some((line) => line.startsWith('ok    topology: replica set'))).toBe(true)
    expect(lines.some((line) => line.includes('change streams can be opened'))).toBe(true)
  })
})
