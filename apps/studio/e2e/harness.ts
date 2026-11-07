/// <reference lib="dom" />
import { createHmac } from "node:crypto"
import { test as base, expect, type Page } from "@playwright/test"
import { type Db, MongoClient } from "mongodb"

export const OWNER = { email: "owner@studio.test", password: "owner password for studio e2e" }

function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new TypeError(`Not base32: ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

/** RFC 6238 with SHA-1, 6 digits and 30 second steps, as authenticator apps compute it. */
function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return code.toString().padStart(6, "0")
}

let lastStep = -1

/**
 * A code the server has not seen yet. It accepts one step either side of the current one and never the same
 * step twice, so this uses the next unused step and waits when both are spent.
 */
export async function freshCode(secret: string): Promise<string> {
  for (;;) {
    const current = Math.floor(Date.now() / 30_000)
    const step = Math.max(current, lastStep + 1)
    if (step <= current + 1) {
      lastStep = step
      return totpAt(secret, step)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** Whether the tests can run: they need the replica set the global setup started the server on. */
export const enabled = process.env["CANOPY_TEST_MONGODB_URI"] !== undefined

/** The one time setup token the server printed. */
export function setupToken(): string {
  const token = process.env["STUDIO_E2E_SETUP_TOKEN"]
  if (token === undefined) throw new Error("The global setup did not start canopy-server")
  return token
}

declare global {
  interface Window {
    __cspViolations?: string[]
  }
}

/** Records every Content Security Policy violation the page reports, from before any script runs. */
async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations?.push(
        `${event.effectiveDirective} blocked ${event.blockedURI || "inline"} in ${event.sourceFile}:${event.lineNumber} ${event.sample}`,
      )
    })
  })
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text()))
      consoleViolations.push(message.text())
  })
}

const consoleViolations: string[] = []

/** Fails when the page reported a CSP violation since it loaded, or the console logged one. */
export async function expectNoCspViolations(page: Page): Promise<void> {
  const reported = await page.evaluate(() => window.__cspViolations?.splice(0) ?? [])
  expect([...reported, ...consoleViolations.splice(0)]).toEqual([])
}

/** Tests sharing one signed in page, checked for CSP violations after each test. */
export const test = base.extend<object, { studio: Page }>({
  studio: [
    async ({ browser }, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL
      const context = await browser.newContext(baseURL === undefined ? {} : { baseURL })
      const page = await context.newPage()
      await watchCsp(page)
      await use(page)
      await context.close()
    },
    { scope: "worker" },
  ],
})

export { expect }

/** Runs `use` on the app database of the run, or with a suffix on its meta (`_meta`) or auth database. */
export async function withMongo<T>(use: (db: Db) => Promise<T>, suffix = ""): Promise<T> {
  const uri = process.env["CANOPY_TEST_MONGODB_URI"]
  const database = process.env["STUDIO_E2E_DATABASE"]
  if (uri === undefined || database === undefined) throw new Error("The global setup did not run")
  const client = new MongoClient(uri)
  try {
    return await use(client.db(`${database}${suffix}`))
  } finally {
    await client.close()
  }
}
