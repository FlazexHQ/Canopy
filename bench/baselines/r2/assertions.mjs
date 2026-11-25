function deepEqual(actual, expected) {
  if (Object.is(actual, expected)) return true
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  ) {
    return false
  }
  const keys = Object.keys(expected)
  return (
    Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected) &&
    Object.keys(actual).length === keys.length &&
    keys.every((key) => Object.hasOwn(actual, key) && deepEqual(actual[key], expected[key]))
  )
}

function ok(condition, message = "Assertion failed") {
  if (!condition) throw new Error(message)
}

export const assert = {
  ok,
  equal(actual, expected, message = "Values differ") {
    ok(Object.is(actual, expected), `${message}: expected ${expected}, got ${actual}`)
  },
  deepEqual(actual, expected, message = "Structures differ") {
    ok(deepEqual(actual, expected), message)
  },
  throws(action, expected = {}) {
    try {
      action()
    } catch (error) {
      for (const [key, value] of Object.entries(expected)) {
        this.equal(error[key], value, key)
      }
      return
    }
    throw new Error("Expected an exception")
  },
}
