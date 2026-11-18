const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const { WASI, getDefaultContext, instantiateNapiModuleSync } = require("@napi-rs/wasm-runtime")

const bytes = readFileSync(join(__dirname, "canopy-native.wasm32-wasi.wasm"))
const compiled = new WebAssembly.Module(bytes)
const memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true })

const { napiModule } = instantiateNapiModuleSync(compiled, {
  context: getDefaultContext(),
  asyncWorkPoolSize: 0,
  wasi: new WASI({ version: "preview1" }),
  overwriteImports(importObject) {
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      memory,
    }
    return importObject
  },
  beforeInit({ instance }) {
    for (const name of Object.keys(instance.exports)) {
      if (name.startsWith("__napi_register__")) instance.exports[name]()
    }
  },
})

module.exports = napiModule.exports
