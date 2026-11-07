export default {
  policies: { source: "database" },
  realtime: { checkpoints: "off" },
  auth: { kind: "builtin", emailPassword: { requireEmailVerification: false } },
}
