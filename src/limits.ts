/** Runner resource policy, not consensus: the largest byte string a manifest or claim may name. */
export const MAX_BYTES = 1_048_576;
/** Runner resource policy: the most live Cells one script-filtered query may select before it is an execution error. */
export const MAX_SELECTED_CELLS = 1_000;
/** Page size for indexer queries; every non-final page carries exactly this many objects. */
export const INDEXER_PAGE_LIMIT = 100;
