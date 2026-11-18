/** A MongoDB query filter compiled once and matched against raw BSON documents. */
export declare class Filter {
  private constructor()
  /** Compiles a filter given as EJSON text (relaxed or canonical). */
  static fromEjson(text: string): Filter
  /** Compiles a filter given as one BSON document. */
  static fromBson(bytes: Uint8Array): Filter
  /** Matches one BSON document. Throws when the bytes are malformed or the matcher cannot decide. */
  matches(document: Uint8Array): boolean
  /** One byte per document: 0 no match, 1 match, 2 undecided (treat as a refusal). */
  matchMany(documents: Uint8Array[]): Uint8Array
  /** Like `matchMany` for BSON documents laid end to end in one buffer. */
  matchConcatenated(documents: Uint8Array): Uint8Array
}

/** Several filters matched against one document per call. */
export declare class FilterSet {
  private constructor()
  /** Compiles each filter given as EJSON text. */
  static fromEjson(texts: string[]): FilterSet
  /** One byte per filter: 0 no match, 1 match, 2 undecided (treat as a refusal). */
  matchDocument(document: Uint8Array): Uint8Array
}

/** `native` for the Node-API addon, `wasm` for the WebAssembly fallback. */
export declare function engine(): string
/** Does nothing; measures the bare cost of a call across the boundary. */
export declare function noop(): void
/** Returns the length of a buffer; measures the cost of passing one across the boundary. */
export declare function noopBytes(bytes: Uint8Array): number
/** The file or package the binding was loaded from. */
export declare const loadedFrom: string
