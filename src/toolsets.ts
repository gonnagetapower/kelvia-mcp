/**
 * Tools are grouped into toolsets so a client can load only the part of Kelvia
 * it needs. The full surface costs roughly 11k tokens of schema in every
 * session, which is wasteful for an agent that only files bugs or only plans a
 * day. The `core` group is always registered and is not selectable.
 */
export const TOOLSETS = ["boards", "tasks", "comments", "stages", "members", "planner", "tags"] as const;

export type Toolset = (typeof TOOLSETS)[number];

/**
 * Parses a toolset selection ("boards,tasks", "all", empty) into the set of
 * enabled toolsets.
 *
 * Fails open: an empty, unrecognised, or misspelled selection yields every
 * toolset rather than an empty one, so a typo in a client config degrades to
 * "more tools than needed" instead of a server that appears to have none.
 */
export function parseToolsets(raw: string | undefined | null): Set<Toolset> {
  const requested = (raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0 || requested.includes("all")) return new Set(TOOLSETS);
  const selected = TOOLSETS.filter((name) => requested.includes(name));
  return new Set(selected.length > 0 ? selected : TOOLSETS);
}
