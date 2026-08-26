// Shared AST helpers for the rules in this folder.
//
// Oxlint plugin AST nodes are passed in untyped. Each helper narrows from
// `unknown` so rule files can call them without per-call type ceremony or
// shared type-import boilerplate.
export const filenameForContext = (context) => (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
export const isAstNode = (node) => typeof node === "object" &&
    node !== null &&
    "type" in node &&
    typeof node.type === "string" &&
    "range" in node;
export const isIdentifier = (node, name) => {
    if (!isAstNode(node) || node.type !== "Identifier") {
        return false;
    }
    if (typeof node.name !== "string") {
        return false;
    }
    return name === undefined || node.name === name;
};
export const isStringLiteral = (node) => isAstNode(node) && node.type === "Literal" && typeof node.value === "string";
// Resolve the static name of a Property or MemberExpression key:
// Identifier.name or string-Literal.value. Returns null for computed keys
// driven by a non-literal expression.
export const getPropertyName = (node) => {
    if (isIdentifier(node)) {
        return node.name;
    }
    if (isStringLiteral(node)) {
        return node.value;
    }
    return null;
};
// Match `<object>.<property>` member access where both halves are
// Identifiers and the access is not computed.
export const isMemberAccess = (node, object, property) => isAstNode(node) &&
    node.type === "MemberExpression" &&
    node.computed === false &&
    isIdentifier(node.object, object) &&
    isIdentifier(node.property, property);
// Match `CallExpression` whose callee is an Identifier with the given name.
export const isCallTo = (node, name) => isAstNode(node) &&
    node.type === "CallExpression" &&
    isIdentifier(node.callee, name);
// Resolve the dot-notation name of a callee: an Identifier, or a
// non-computed MemberExpression chain (e.g. `t.String`, `Schema.is`,
// `process.stderr.write`). Returns null when the chain is computed
// or the property name itself can't be resolved.
//
// If the chain is rooted at a non-Identifier expression (e.g. `foo().bar`),
// returns the bare property name ("bar") rather than null. Callers that
// match the result against a fixed allowlist must consider whether they
// need to distinguish `foo().createSafeHandler` from `createSafeHandler`.
export const getCalleeName = (callee) => {
    if (isIdentifier(callee)) {
        return callee.name;
    }
    if (!isAstNode(callee) || callee.type !== "MemberExpression") {
        return null;
    }
    if (callee.computed !== false) {
        return null;
    }
    const objectName = getCalleeName(callee.object);
    const propertyName = getPropertyName(callee.property);
    if (propertyName === null) {
        return null;
    }
    return objectName === null ? propertyName : `${objectName}.${propertyName}`;
};
// Peel TS-only wrapping nodes so a shape check sees the underlying
// expression. Returns the original node when no wrapping is present.
export const unwrapExpression = (node) => {
    if (!isAstNode(node)) {
        return null;
    }
    if (node.type === "TSAsExpression" ||
        node.type === "TSSatisfiesExpression" ||
        node.type === "ChainExpression") {
        return unwrapExpression(node.expression);
    }
    return node;
};
// Resolve an ImportSpecifier's imported binding name (Identifier.name or
// string-Literal.value). Returns null when the specifier shape is unexpected.
export const getImportedName = (specifier) => {
    if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
        return null;
    }
    const imported = specifier.imported;
    if (isIdentifier(imported)) {
        return imported.name;
    }
    if (isStringLiteral(imported)) {
        return imported.value;
    }
    return null;
};
// Resolve an ImportSpecifier's local binding name. This differs from
// getImportedName for aliased imports such as `import { source as local }`.
export const getImportLocalName = (specifier) => {
    if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
        return null;
    }
    return isIdentifier(specifier.local) ? specifier.local.name : null;
};
