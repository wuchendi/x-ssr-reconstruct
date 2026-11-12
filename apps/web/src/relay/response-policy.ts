// What a GraphQL response with errors means for us.
//
// Relay ignores field errors when there is data, so an error that bubbled up
// to null the root (a non-null field failed) would render as "nothing there"
// with no sign of failure. Policy:
// - errors and no root data left: the operation failed -> throw (the section's
//   error boundary shows it; on the server the boundary goes to the browser);
// - errors with some root data: partial success -> keep the data, report;
// - no errors: as is, nulls included ("not found" is not a failure).
import type { GraphQLResponse } from 'relay-runtime'

type GraphQLError = { message: string; path?: ReadonlyArray<string | number> }

export function checkResponse(
  response: GraphQLResponse,
  operationName: string,
  onPartial?: (operationName: string, errors: ReadonlyArray<GraphQLError>) => void,
): GraphQLResponse {
  if (Array.isArray(response)) return response
  const errors = (response as { errors?: ReadonlyArray<GraphQLError> }).errors
  if (!errors?.length) return response
  const data = (response as { data?: Record<string, unknown> | null }).data
  const roots = data ? Object.values(data) : []
  if (roots.every((value) => value == null)) {
    throw new Error(`${operationName} failed: ${errors.map((e) => e.message).join('; ')}`)
  }
  onPartial?.(operationName, errors)
  return response
}
