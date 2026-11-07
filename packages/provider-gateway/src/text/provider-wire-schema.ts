type Schema = Record<string, unknown>;

/** Provider schema subsets never replace the original local acceptance schema. */
export function providerWireSchema(schema: object, provider: "anthropic" | "gemini"): object {
  const unsupported = new Set(provider === "anthropic"
    ? ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems"]
    : ["minLength", "maxLength"]);
  const visit = (node: unknown): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const result: Schema = {}, constraints: Schema = {};
    for (const [key, value] of Object.entries(node)) {
      if (unsupported.has(key) || (provider === "anthropic" && key === "minItems" && value !== 0 && value !== 1)) { constraints[key] = value; continue; }
      if (["properties", "$defs", "definitions", "patternProperties"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) result[key] = Object.fromEntries(Object.entries(value).map(([name, field]) => [name, visit(field)]));
      else if (["items", "additionalProperties", "not", "if", "then", "else"].includes(key)) result[key] = visit(value);
      else if (["anyOf", "allOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(value)) result[key] = value.map(visit);
      else result[key] = value;
    }
    if (Object.keys(constraints).length) result.description = `${typeof result.description === "string" ? result.description + " " : ""}应用程序将严格校验以下限制：${JSON.stringify(constraints)}`;
    return result;
  };
  return visit(schema) as object;
}
