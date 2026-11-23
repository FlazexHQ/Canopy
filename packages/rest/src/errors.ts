import {
  CanopyError,
  ErrorCode,
  InvalidQueryError,
  serverErrorCode,
  ValidationError,
} from "@canopy/protocol"
import {
  type Document,
  MongoBulkWriteError,
  MongoError,
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
  type WriteError,
} from "mongodb"

const DUPLICATE_KEY = 11000
const DOCUMENT_VALIDATION_FAILURE = 121
const MAX_TIME_EXPIRED = 50
/**
 * The codes of a deployment without MongoDB Search: `SearchNotEnabled` on MongoDB 8.0 and later, and the
 * code MongoDB 7.0 answers with ("$search stage is only allowed on MongoDB Atlas").
 */
const SEARCH_NOT_ENABLED = new Set([31082, 6047401])

/** Whether MongoDB refused a search stage or command because the deployment has no MongoDB Search. */
export function isSearchUnavailable(error: unknown): boolean {
  if (!(error instanceof MongoServerError)) return false
  const code = serverErrorCode(error)
  return code !== undefined && SEARCH_NOT_ENABLED.has(code)
}
/** BadValue, FailedToParse, TypeMismatch, NoQueryExecutionPlans and invalid regular expressions. */
const REJECTED_QUERY = new Set([2, 9, 14, 291, 51091])

/**
 * Converts a driver failure into a {@link CanopyError}. Only `service` callers see the server's details
 * (the validator's reason or the duplicated key), because they can reveal invisible documents.
 */
export function fromDriverError(error: unknown, service: boolean): CanopyError {
  if (error instanceof CanopyError) return error
  if (error instanceof MongoServerError) {
    const code = serverErrorCode(error)
    if (code === DUPLICATE_KEY) {
      const keyValue: unknown = error["keyValue"]
      return new CanopyError(ErrorCode.DuplicateKey, "A document with the same unique key exists", {
        cause: error,
        ...(service && keyValue !== undefined ? { details: { keyValue } } : {}),
      })
    }
    if (code === DOCUMENT_VALIDATION_FAILURE) {
      const reason: Document | undefined = error.errInfo ?? firstWriteError(error)?.errInfo
      return new ValidationError("The document failed the collection validator", {
        cause: error,
        ...(service && reason !== undefined ? { details: { reason } } : {}),
      })
    }
    if (isSearchUnavailable(error))
      return new CanopyError(
        ErrorCode.Unavailable,
        "Search is not available on this MongoDB deployment; it needs Atlas, an Atlas local deployment or MongoDB Search",
        { cause: error },
      )
    if (code === MAX_TIME_EXPIRED)
      return new CanopyError(ErrorCode.Timeout, "The operation took too long", { cause: error })
    if (code !== undefined && REJECTED_QUERY.has(code))
      return new InvalidQueryError("MongoDB rejected the query", {
        cause: error,
        ...(service ? { details: { reason: error.message } } : {}),
      })
  }
  if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError)
    return new CanopyError(ErrorCode.Unavailable, "MongoDB is unavailable", { cause: error })
  if (error instanceof MongoError && error.hasErrorLabel("TransientTransactionError"))
    return new CanopyError(ErrorCode.Unavailable, "The write could not commit; retry it", {
      cause: error,
    })
  return new CanopyError(ErrorCode.Internal, "Internal error", { cause: error })
}

function firstWriteError(error: MongoServerError): WriteError | undefined {
  if (!(error instanceof MongoBulkWriteError)) return undefined
  const errors = error.writeErrors
  return Array.isArray(errors) ? errors[0] : (errors as WriteError)
}
