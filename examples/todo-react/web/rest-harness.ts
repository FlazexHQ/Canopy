import { isCanopyError, ObjectId } from "canopy.js"
import { createRestClient } from "canopy.js/rest"
import { schema } from "./canopy.schema.ts"
import { token, user } from "./session.ts"

const key = document.querySelector<HTMLMetaElement>('meta[name="canopy-key"]')
if (!key) throw new Error("Missing publishable key")

/** Browser bindings the REST spec loads in place of the React entry point. */
const restHarness = {
  createRestClient: () =>
    createRestClient({ url: location.origin, publishableKey: key.content, schema, token }),
  isCanopyError,
  ObjectId,
  user,
}

Object.assign(window, { restHarness })
