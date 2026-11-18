import { describe, expect, it } from "vitest"
import { signWebhook, verifyWebhook, webhookHeaders } from "../src/index.ts"

// The test vector of the Standard Webhooks reference libraries.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek"
const TIMESTAMP = 1614265330
const BODY = '{"test": 2432232314}'
const SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="

describe("webhook signatures", () => {
  it("matches the Standard Webhooks reference vector", async () => {
    expect(await signWebhook(SECRET, ID, TIMESTAMP, BODY)).toBe(SIGNATURE)
  })

  it("verifies a reference request within the tolerance", async () => {
    const headers = {
      "webhook-id": ID,
      "webhook-timestamp": String(TIMESTAMP),
      "webhook-signature": SIGNATURE,
    }
    const now = (TIMESTAMP + 60) * 1000
    expect(await verifyWebhook(SECRET, headers, BODY, { now })).toBe(true)
    expect(await verifyWebhook(SECRET, new Headers(headers), BODY, { now })).toBe(true)
  })

  it("accepts any of several space separated signatures", async () => {
    const headers = {
      "webhook-id": ID,
      "webhook-timestamp": String(TIMESTAMP),
      "webhook-signature": `v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc= ${SIGNATURE}`,
    }
    expect(await verifyWebhook(SECRET, headers, BODY, { now: TIMESTAMP * 1000 })).toBe(true)
  })

  it("refuses a changed body, id, timestamp or secret", async () => {
    const headers = {
      "webhook-id": ID,
      "webhook-timestamp": String(TIMESTAMP),
      "webhook-signature": SIGNATURE,
    }
    const now = TIMESTAMP * 1000
    expect(await verifyWebhook(SECRET, headers, '{"test": 2432232315}', { now })).toBe(false)
    expect(
      await verifyWebhook(SECRET, { ...headers, "webhook-id": "msg_other" }, BODY, { now }),
    ).toBe(false)
    expect(
      await verifyWebhook(
        SECRET,
        { ...headers, "webhook-timestamp": String(TIMESTAMP + 1) },
        BODY,
        {
          now,
        },
      ),
    ).toBe(false)
    expect(await verifyWebhook("whsec_AAAAAAAAAAAAAAAAAAAAAAAA", headers, BODY, { now })).toBe(
      false,
    )
  })

  it("refuses stale or future timestamps and missing headers", async () => {
    const headers = {
      "webhook-id": ID,
      "webhook-timestamp": String(TIMESTAMP),
      "webhook-signature": SIGNATURE,
    }
    expect(await verifyWebhook(SECRET, headers, BODY, { now: (TIMESTAMP + 301) * 1000 })).toBe(
      false,
    )
    expect(await verifyWebhook(SECRET, headers, BODY, { now: (TIMESTAMP - 301) * 1000 })).toBe(
      false,
    )
    expect(
      await verifyWebhook(SECRET, headers, BODY, {
        now: (TIMESTAMP + 3600) * 1000,
        toleranceSeconds: 3600,
      }),
    ).toBe(true)
    const { "webhook-signature": _, ...unsigned } = headers
    expect(await verifyWebhook(SECRET, unsigned, BODY, { now: TIMESTAMP * 1000 })).toBe(false)
  })

  it("signs with the UTF-8 bytes of a secret without the whsec_ prefix", async () => {
    const plain = "a plain secret of some length"
    const headers = await webhookHeaders(plain, "id1", "{}", 1_700_000_000_000)
    expect(headers["webhook-timestamp"]).toBe("1700000000")
    expect(await verifyWebhook(plain, headers, "{}", { now: 1_700_000_000_000 })).toBe(true)
    expect(
      await verifyWebhook(`whsec_${btoa(plain)}`, headers, "{}", { now: 1_700_000_000_000 }),
    ).toBe(true)
  })
})
