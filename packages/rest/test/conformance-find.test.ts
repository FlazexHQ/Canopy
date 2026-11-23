import { fileURLToPath } from "node:url"
import { replayRecordedCases } from "./conformance/replay.ts"

await replayRecordedCases(
  "find",
  fileURLToPath(new URL("../../../conformance/http/find", import.meta.url)),
  200,
)
