import { fileURLToPath } from "node:url"
import { replayRecordedCases } from "./conformance/replay.ts"

await replayRecordedCases(
  "reads",
  fileURLToPath(new URL("../../../conformance/http/reads", import.meta.url)),
  70,
)
