if (process.env["CANOPY_PUBLISH_POLICIES"] !== "off") {
  for (const args of [["migrate"], ["policies", "push", "--dir", "/app/policies"]]) {
    const command = Bun.spawn(["bun", "packages/cli/dist/cli.js", ...args], {
      stdout: "inherit",
      stderr: "inherit",
    })
    const status = await command.exited
    if (status !== 0) process.exit(status)
  }
}
