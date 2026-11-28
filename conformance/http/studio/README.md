# Standalone Studio HTTP oracle

Run `bun run vectors:http-studio` to capture the standalone service and add `--check` to compare with the committed answers. The vectors include the asset fixture, its fixed modification time in Unix seconds, the request origin and the request and response for each case.

The cases pin the security headers and CSP, both health routes, redirects, the application fallback, immutable and revalidated assets, HEAD and conditional requests, refusals, and the response for an unbuilt app. The fixture fixes the inputs to ETag generation. No output substitutions are needed.

The Bun and Node files preserve a runtime difference in the implicit content type of the health responses. Use Node with the recorder at `packages/testing/scripts/http-studio-vectors.ts` to capture or compare the Node file.
