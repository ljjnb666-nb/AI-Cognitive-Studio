import Ajv2020 from "ajv/dist/2020.js";

type CompiledValidator = (data: unknown) => boolean;

/** Uses the same JSON Schema semantics for request preflight and provider output. */
export function compileStrictJsonSchema(schema: object): CompiledValidator {
  const validator = new (Ajv2020 as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: object): CompiledValidator })({ allErrors: false, strict: false });
  return validator.compile(schema);
}
