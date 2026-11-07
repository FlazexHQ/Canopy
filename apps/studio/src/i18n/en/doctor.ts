export const doctor = {
  title: "Doctor",
  description: "The canopy doctor checks: what each one found and how to fix it.",
  rerun: "Run again",
  running: "Running…",
  summary: "{errors} errors, {warnings} warnings, {passed} passed",
  topology: "Topology: {value}",
  serverVersion: "MongoDB {value}",
  groups: {
    error: "Errors",
    warn: "Warnings",
    info: "Notes",
    ok: "Passed",
  },
  fix: "Fix",
  fixLabel: "the fix",
  docs: "Documentation for {title}",
} as const
