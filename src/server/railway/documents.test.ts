import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, parse, validate, type OperationDefinitionNode } from "graphql";
import { describe, expect, it } from "vitest";
import { documents } from "./documents";

/**
 * Railway's schema as introspected (no token needed) on the day of the probe.
 * `assumeValid` skips graphql-js's check of the schema itself, which Railway's
 * fails (a deprecated `Team.id` implementing a non-deprecated `Node.id`). The
 * documents are still validated in full.
 */
const sdl = readFileSync(join(import.meta.dirname, "../../../schema/railway.graphql"), "utf8");
const schema = buildSchema(sdl, { assumeValid: true });

describe("GraphQL documents", () => {
  it.each(Object.values(documents))("$name is valid against the committed Railway schema", (document) => {
    expect(validate(schema, parse(document.text)).map((error) => error.message)).toEqual([]);
  });

  it("would catch a field that does not exist", () => {
    const errors = validate(schema, parse("query { projectToken { nope } }"));
    expect(errors.map((error) => error.message)).toEqual([expect.stringContaining('Cannot query field "nope" on type "ProjectToken"')]);
  });

  it.each(Object.values(documents))("$name is labelled with its real name and kind", (document) => {
    const [operation] = parse(document.text).definitions as OperationDefinitionNode[];
    expect(operation.name?.value).toBe(document.name);
    expect(operation.operation).toBe(document.kind);
  });
});
