if (
  process.env["CANOPY_REQUIRE_MONGODB"] === "1" &&
  process.env["CANOPY_TEST_MONGODB_URI"] === undefined
)
  throw new Error(
    "CANOPY_REQUIRE_MONGODB is set but CANOPY_TEST_MONGODB_URI is not: the MongoDB suites would be skipped",
  )
