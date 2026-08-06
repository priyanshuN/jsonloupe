/** Complete exports are bounded even though they never enter the MCP response. */
export const MAX_EXPORT_BYTES = 50_000_000;

/** Keep each producer/consumer hand-off small while avoiding tiny file writes. */
export const EXPORT_CHUNK_BYTES = 256 * 1024;
