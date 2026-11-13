import { allow, collection } from "@canopy/policy"

/** A scratch collection for local work: anyone holding a publishable key may use the documents marked public. */
export default collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("anon").where({ public: true }),
    allow.insert("anon").check({ public: true }),
    allow.update("anon").where({ public: true }).check({ public: true }),
    allow.delete("anon").where({ public: true }),
  ],
})
