const disabledValues = new Set(["0", "false", "off"]);

/**
 * An unset switch leaves generation available. Production freezes generation
 * only when GENERATION_P0_FREEZE is explicitly set to a truthy value.
 */
export function isGenerationFrozen(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized !== "" && !disabledValues.has(normalized);
}