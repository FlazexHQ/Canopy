import type {
  Auth0Input,
  ClerkInput,
  ExternalAuthInput,
  FirebaseInput,
  SupabaseInput,
} from "./types.ts"

type Without<T> = Omit<T, "kind">

/**
 * Bring your own identity provider: tokens are verified against its JWKS with a pinned algorithm, and
 * `iss` and `aud` are required. Presets fill in the endpoints of common providers.
 */
export const external: {
  (options: Without<ExternalAuthInput>): ExternalAuthInput
  /** Auth0: `external.auth0({ domain: env("AUTH0_DOMAIN"), audience: "https://api.example.com" })`. */
  auth0(options: Without<Auth0Input>): Auth0Input
  /** Clerk, through a JWT template that sets `aud`. */
  clerk(options: Without<ClerkInput>): ClerkInput
  /** Firebase Authentication ID tokens of one project. */
  firebase(options: Without<FirebaseInput>): FirebaseInput
  /** Supabase Auth with asymmetric signing keys. */
  supabase(options: Without<SupabaseInput>): SupabaseInput
} = Object.assign(
  (options: Without<ExternalAuthInput>): ExternalAuthInput => ({ kind: "external", ...options }),
  {
    auth0: (options: Without<Auth0Input>): Auth0Input => ({ kind: "auth0", ...options }),
    clerk: (options: Without<ClerkInput>): ClerkInput => ({ kind: "clerk", ...options }),
    firebase: (options: Without<FirebaseInput>): FirebaseInput => ({
      kind: "firebase",
      ...options,
    }),
    supabase: (options: Without<SupabaseInput>): SupabaseInput => ({
      kind: "supabase",
      ...options,
    }),
  },
)
