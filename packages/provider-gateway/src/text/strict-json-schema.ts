import Ajv from "ajv/dist/ajv.js";

type CompiledValidator = (data: unknown) => boolean;

/** Uses the same JSON Schema semantics for request preflight and provider output. */
export function compileStrictJsonSchema(schema: object): CompiledValidator {
  const validator = new (Ajv as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: object): CompiledValidator })({ allErrors: false, strict: false });
  return validator.compile(schema);
}
