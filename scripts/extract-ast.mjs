#!/usr/bin/env node
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const traverse = traverseModule.default || traverseModule;

const SUPPORTED_EXTS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
]);

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node scripts/extract-ast.mjs <file>");
    process.exit(1);
  }

  const fullPath = path.resolve(process.cwd(), input);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    console.error(`Unsupported file type: ${ext}`);
    process.exit(1);
  }

  let result;
  if (ext === ".py") {
    result = extractPython(fullPath);
  } else {
    result = extractJsTs(fullPath, ext);
  }

  printOutline(result, path.relative(process.cwd(), fullPath));
}

function printOutline(result, displayPath) {
  console.log(`FILE ${displayPath}`);
  console.log("");

  for (const item of result.items) {
    printItem(item, 0);
  }
}

function printItem(item, level) {
  const indent = "  ".repeat(level);
  console.log(indent + formatItemLine(item));
  for (const child of item.children || []) {
    printItem(child, level + 1);
  }
}

function formatItemLine(item) {
  const parts = [];

  if (item.export) parts.push("export");
  if (item.defaultExport) parts.push("default");
  if (item.visibility) parts.push(item.visibility);
  if (item.static) parts.push("static");
  if (item.async) parts.push("async");

  if (item.kind === "class") {
    parts.push("class");
    parts.push(item.name || "<anonymous>");

    if (item.extends) {
      parts.push(`extends ${item.extends}`);
    }
    if (item.implements?.length) {
      parts.push(`implements ${item.implements.join(", ")}`);
    }

    parts.push(`@ L${item.startLine}-L${item.endLine}`);
    return parts.join(" ");
  }

  if (item.kind === "constructor") {
    parts.push("ctor");
    parts.push(`(${formatParams(item.params)})`);
    parts.push(`@ L${item.startLine}-L${item.endLine}`);
    return parts.join(" ");
  }

  if (item.kind === "method") {
    parts.push("method");
    parts.push(`${item.name || "<anonymous>"}(${formatParams(item.params)})`);
    if (item.returnType) {
      parts[parts.length - 1] += `: ${item.returnType}`;
    }
    parts.push(`@ L${item.startLine}-L${item.endLine}`);
    return parts.join(" ");
  }

  parts.push("fn");
  parts.push(`${item.name || "<anonymous>"}(${formatParams(item.params)})`);
  if (item.returnType) {
    parts[parts.length - 1] += `: ${item.returnType}`;
  }
  parts.push(`@ L${item.startLine}-L${item.endLine}`);
  return parts.join(" ");
}

function formatParams(params) {
  return (params || [])
    .map((p) => {
      if (p.type) return `${p.name}: ${p.type}`;
      return p.name;
    })
    .join(", ");
}

/* =========================
 * JS / TS
 * ========================= */

function extractJsTs(filePath, ext) {
  const code = fs.readFileSync(filePath, "utf8");
  const isTs = ext === ".ts" || ext === ".tsx";
  const isJsx = ext === ".jsx" || ext === ".tsx";

  const ast = parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "decorators-legacy",
      "topLevelAwait",
      "dynamicImport",
      "objectRestSpread",
      "optionalChaining",
      "nullishCoalescingOperator",
      "asyncGenerators",
      "numericSeparator",
      "logicalAssignment",
      ...(isJsx ? ["jsx"] : []),
      ...(isTs ? ["typescript"] : []),
    ],
  });

  const exportMap = buildJsExportMap(ast);
  const topItems = [];

  for (const node of ast.program.body) {
    const extracted = extractTopLevelJsNode(node, exportMap);
    if (Array.isArray(extracted)) {
      topItems.push(...extracted.filter(Boolean));
    } else if (extracted) {
      topItems.push(extracted);
    }
  }

  return { items: topItems };
}

function buildJsExportMap(ast) {
  const exportMap = new Map();

  for (const node of ast.program.body) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const decl = node.declaration;
        if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
          if (decl.id?.name) {
            exportMap.set(decl.id.name, { export: true, defaultExport: false });
          }
        } else if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations) {
            if (d.id?.type === "Identifier") {
              exportMap.set(d.id.name, { export: true, defaultExport: false });
            }
          }
        }
      }

      for (const spec of node.specifiers || []) {
        const localName = spec.local?.name;
        if (localName) {
          exportMap.set(localName, { export: true, defaultExport: false });
        }
      }
    }

    if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (
        (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") &&
        decl.id?.name
      ) {
        exportMap.set(decl.id.name, { export: true, defaultExport: true });
      } else if (decl.type === "Identifier") {
        exportMap.set(decl.name, { export: true, defaultExport: true });
      }
    }
  }

  return exportMap;
}

function extractTopLevelJsNode(node, exportMap) {
  switch (node.type) {
    case "FunctionDeclaration":
      return buildJsFunctionItem(node, {
        kind: "function",
        exportInfo: exportMap.get(node.id?.name),
      });

    case "ClassDeclaration":
      return buildJsClassItem(node, exportMap.get(node.id?.name));

    case "VariableDeclaration":
      return node.declarations
        .map((d) => extractJsVariableDeclarator(d, exportMap))
        .filter(Boolean);

    case "ExportNamedDeclaration":
      if (!node.declaration) return null;
      return extractTopLevelJsNode(node.declaration, exportMap);

    case "ExportDefaultDeclaration":
      return extractExportDefaultNode(node.declaration, exportMap);

    default:
      return null;
  }
}

function extractExportDefaultNode(node, exportMap) {
  if (!node) return null;

  if (node.type === "FunctionDeclaration") {
    return buildJsFunctionItem(node, {
      kind: "function",
      exportInfo: { export: true, defaultExport: true },
    });
  }

  if (node.type === "ClassDeclaration") {
    return buildJsClassItem(node, { export: true, defaultExport: true });
  }

  if (node.type === "Identifier") {
    return null;
  }

  if (isJsFunctionLike(node)) {
    return buildJsFunctionLikeExpressionItem(node, {
      name: "default",
      exportInfo: { export: true, defaultExport: true },
    });
  }

  return null;
}

function extractJsVariableDeclarator(decl, exportMap) {
  if (!decl.id || decl.id.type !== "Identifier" || !decl.init) return null;
  const name = decl.id.name;
  const exportInfo = exportMap.get(name);

  if (isJsFunctionLike(decl.init)) {
    return buildJsFunctionLikeExpressionItem(decl.init, {
      name,
      exportInfo,
    });
  }

  if (decl.init.type === "ClassExpression") {
    return buildJsClassItem(decl.init, exportInfo, name);
  }

  return null;
}

function isJsFunctionLike(node) {
  return (
    node &&
    (node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression")
  );
}

function buildJsFunctionLikeExpressionItem(node, { name, exportInfo }) {
  return {
    kind: "function",
    name: name || node.id?.name || "<anonymous>",
    export: !!exportInfo?.export,
    defaultExport: !!exportInfo?.defaultExport,
    async: !!node.async,
    static: false,
    visibility: null,
    params: extractJsParams(node.params),
    returnType: getJsReturnType(node),
    startLine: node.loc?.start?.line ?? 0,
    endLine: node.loc?.end?.line ?? 0,
    children: extractJsNestedItemsFromBody(node.body),
  };
}

function buildJsFunctionItem(node, options = {}) {
  return {
    kind: options.kind === "method" ? "method" : "function",
    name: node.id?.name || options.name || "<anonymous>",
    export: !!options.exportInfo?.export,
    defaultExport: !!options.exportInfo?.defaultExport,
    async: !!node.async,
    static: !!options.static,
    visibility: options.visibility || null,
    params: extractJsParams(node.params),
    returnType: getJsReturnType(node),
    startLine: node.loc?.start?.line ?? 0,
    endLine: node.loc?.end?.line ?? 0,
    children: extractJsNestedItemsFromBody(node.body),
  };
}

function buildJsClassItem(node, exportInfo = null, fallbackName = null) {
  const item = {
    kind: "class",
    name: node.id?.name || fallbackName || "<anonymous>",
    export: !!exportInfo?.export,
    defaultExport: !!exportInfo?.defaultExport,
    async: false,
    static: false,
    visibility: null,
    extends: node.superClass ? renderJsNodeText(node.superClass) : null,
    implements: Array.isArray(node.implements)
      ? node.implements.map((x) => renderJsNodeText(x.expression || x))
      : [],
    startLine: node.loc?.start?.line ?? 0,
    endLine: node.loc?.end?.line ?? 0,
    children: [],
  };

  const body = node.body?.body || [];
  for (const member of body) {
    if (
      member.type === "ClassMethod" ||
      member.type === "ClassPrivateMethod" ||
      member.type === "TSDeclareMethod"
    ) {
      if (member.kind === "constructor") {
        item.children.push({
          kind: "constructor",
          name: "constructor",
          export: false,
          defaultExport: false,
          async: false,
          static: false,
          visibility: getJsVisibility(member),
          params: extractJsParams(member.params || []),
          returnType: null,
          startLine: member.loc?.start?.line ?? 0,
          endLine: member.loc?.end?.line ?? 0,
          children: extractJsNestedItemsFromBody(member.body),
        });
      } else {
        item.children.push({
          kind: "method",
          name: getJsMemberName(member),
          export: false,
          defaultExport: false,
          async: !!member.async,
          static: !!member.static,
          visibility: getJsVisibility(member),
          params: extractJsParams(member.params || []),
          returnType: getJsReturnType(member),
          startLine: member.loc?.start?.line ?? 0,
          endLine: member.loc?.end?.line ?? 0,
          children: extractJsNestedItemsFromBody(member.body),
        });
      }
    } else if (
      member.type === "ClassProperty" ||
      member.type === "ClassPrivateProperty" ||
      member.type === "PropertyDefinition"
    ) {
      if (isJsFunctionLike(member.value)) {
        item.children.push({
          kind: "method",
          name: getJsMemberName(member),
          export: false,
          defaultExport: false,
          async: !!member.value.async,
          static: !!member.static,
          visibility: getJsVisibility(member),
          params: extractJsParams(member.value.params || []),
          returnType: getJsReturnType(member.value) || getTsTypeAnnotationText(member.typeAnnotation),
          startLine: member.loc?.start?.line ?? 0,
          endLine: member.loc?.end?.line ?? 0,
          children: extractJsNestedItemsFromBody(member.value.body),
        });
      }
    }
  }

  return item;
}

function extractJsNestedItemsFromBody(body) {
  const items = [];
  if (!body) return items;

  const stmts = body.type === "BlockStatement" ? body.body : [];
  for (const stmt of stmts) {
    if (stmt.type === "FunctionDeclaration") {
      items.push(buildJsFunctionItem(stmt));
      continue;
    }

    if (stmt.type === "ClassDeclaration") {
      items.push(buildJsClassItem(stmt));
      continue;
    }

    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) {
        const maybe = extractJsVariableDeclarator(d, new Map());
        if (maybe) items.push(maybe);
      }
    }
  }

  return items;
}

function extractJsParams(params) {
  return (params || []).map((p) => normalizeJsParam(p));
}

function normalizeJsParam(p) {
  if (!p) return { name: "unknown", type: null };

  if (p.type === "Identifier") {
    return {
      name: p.name,
      type: getTsTypeAnnotationText(p.typeAnnotation),
    };
  }

  if (p.type === "AssignmentPattern") {
    const left = normalizeJsParam(p.left);
    return left;
  }

  if (p.type === "RestElement") {
    const arg = normalizeJsParam(p.argument);
    return {
      name: `...${arg.name}`,
      type: arg.type,
    };
  }

  if (p.type === "ObjectPattern") {
    return {
      name: "{...}",
      type: getTsTypeAnnotationText(p.typeAnnotation),
    };
  }

  if (p.type === "ArrayPattern") {
    return {
      name: "[...]",
      type: getTsTypeAnnotationText(p.typeAnnotation),
    };
  }

  return {
    name: renderJsNodeText(p),
    type: getTsTypeAnnotationText(p.typeAnnotation),
  };
}

function getJsReturnType(node) {
  const tsType = getTsTypeAnnotationText(node.returnType);
  if (tsType) return tsType;
  return null;
}

function getTsTypeAnnotationText(typeAnnotationNode) {
  if (!typeAnnotationNode) return null;
  const inner = typeAnnotationNode.typeAnnotation || typeAnnotationNode;
  if (!inner) return null;
  return renderJsNodeText(inner);
}

function getJsVisibility(node) {
  if (!node) return null;
  if (node.accessibility) return node.accessibility;
  return null;
}

function getJsMemberName(node) {
  const key = node.key;
  if (!key) return "<anonymous>";

  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateName") return `#${key.id?.name || "private"}`;
  if (key.type === "StringLiteral") return JSON.stringify(key.value);
  if (key.type === "NumericLiteral") return String(key.value);

  return renderJsNodeText(key);
}

function renderJsNodeText(node) {
  if (!node) return "";

  switch (node.type) {
    case "Identifier":
      return node.name;

    case "TSVoidKeyword":
      return "void";
    case "TSStringKeyword":
      return "string";
    case "TSNumberKeyword":
      return "number";
    case "TSBooleanKeyword":
      return "boolean";
    case "TSAnyKeyword":
      return "any";
    case "TSUnknownKeyword":
      return "unknown";
    case "TSNeverKeyword":
      return "never";
    case "TSNullKeyword":
      return "null";
    case "TSUndefinedKeyword":
      return "undefined";
    case "TSObjectKeyword":
      return "object";
    case "TSBigIntKeyword":
      return "bigint";
    case "TSSymbolKeyword":
      return "symbol";

    case "TSTypeReference": {
      const name = renderJsNodeText(node.typeName);
      const params = node.typeParameters?.params?.map(renderJsNodeText) || [];
      return params.length ? `${name}<${params.join(", ")}>` : name;
    }

    case "TSQualifiedName":
      return `${renderJsNodeText(node.left)}.${renderJsNodeText(node.right)}`;

    case "TSUnionType":
      return node.types.map(renderJsNodeText).join(" | ");

    case "TSIntersectionType":
      return node.types.map(renderJsNodeText).join(" & ");

    case "TSArrayType":
      return `${renderJsNodeText(node.elementType)}[]`;

    case "TSTupleType":
      return `[${node.elementTypes.map(renderJsNodeText).join(", ")}]`;

    case "TSParenthesizedType":
      return `(${renderJsNodeText(node.typeAnnotation)})`;

    case "TSLiteralType":
      return renderJsNodeText(node.literal);

    case "StringLiteral":
      return JSON.stringify(node.value);

    case "NumericLiteral":
      return String(node.value);

    case "BooleanLiteral":
      return String(node.value);

    case "TSFunctionType": {
      const params = (node.parameters || []).map((p) => normalizeJsParam(p))
        .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
        .join(", ");
      const ret = node.typeAnnotation ? renderJsNodeText(node.typeAnnotation.typeAnnotation) : "unknown";
      return `(${params}) => ${ret}`;
    }

    case "TSLiteralType":
      return renderJsNodeText(node.literal);

    case "TSPropertySignature":
      return renderJsNodeText(node.key);

    case "TSExpressionWithTypeArguments":
      return renderJsNodeText(node.expression);

    case "MemberExpression":
      return `${renderJsNodeText(node.object)}.${renderJsNodeText(node.property)}`;

    case "ThisExpression":
      return "this";

    default:
      if (typeof node.name === "string") return node.name;
      return node.type || "unknown";
  }
}

/* =========================
 * Python
 * ========================= */

function extractPython(filePath) {
  const pyCode = String.raw`
import ast
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    source = f.read()

tree = ast.parse(source, filename=path)

def expr_to_text(node):
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None

def format_param(arg, default=None):
    item = {
        "name": arg.arg,
        "type": expr_to_text(arg.annotation)
    }
    return item

def get_params(args):
    params = []
    posonly = getattr(args, "posonlyargs", [])
    normal = list(posonly) + list(args.args)
    for a in normal:
        params.append(format_param(a))
    if args.vararg:
        params.append({
            "name": "*" + args.vararg.arg,
            "type": expr_to_text(args.vararg.annotation)
        })
    for a in args.kwonlyargs:
        params.append(format_param(a))
    if args.kwarg:
        params.append({
            "name": "**" + args.kwarg.arg,
            "type": expr_to_text(args.kwarg.annotation)
        })
    return params

def is_staticmethod(dec_list):
    for d in dec_list:
        if expr_to_text(d) == "staticmethod":
            return True
    return False

def is_classmethod(dec_list):
    for d in dec_list:
        if expr_to_text(d) == "classmethod":
            return True
    return False

def build_function(node, kind="function"):
    return {
        "kind": kind,
        "name": node.name,
        "export": not node.name.startswith("_"),
        "defaultExport": False,
        "async": isinstance(node, ast.AsyncFunctionDef),
        "static": False,
        "visibility": None,
        "params": get_params(node.args),
        "returnType": expr_to_text(node.returns),
        "startLine": getattr(node, "lineno", 0),
        "endLine": getattr(node, "end_lineno", getattr(node, "lineno", 0)),
        "children": extract_nested(node.body),
    }

def build_class(node):
    item = {
        "kind": "class",
        "name": node.name,
        "export": not node.name.startswith("_"),
        "defaultExport": False,
        "async": False,
        "static": False,
        "visibility": None,
        "extends": ", ".join([expr_to_text(b) for b in node.bases if expr_to_text(b)]) or None,
        "implements": [],
        "startLine": getattr(node, "lineno", 0),
        "endLine": getattr(node, "end_lineno", getattr(node, "lineno", 0)),
        "children": [],
    }

    for stmt in node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if stmt.name == "__init__":
                item["children"].append({
                    "kind": "constructor",
                    "name": "__init__",
                    "export": False,
                    "defaultExport": False,
                    "async": isinstance(stmt, ast.AsyncFunctionDef),
                    "static": False,
                    "visibility": "private" if stmt.name.startswith("_") else "public",
                    "params": get_params(stmt.args),
                    "returnType": None,
                    "startLine": getattr(stmt, "lineno", 0),
                    "endLine": getattr(stmt, "end_lineno", getattr(stmt, "lineno", 0)),
                    "children": extract_nested(stmt.body),
                })
            else:
                visibility = "private" if stmt.name.startswith("_") else "public"
                static = is_staticmethod(stmt.decorator_list)
                if is_classmethod(stmt.decorator_list):
                    static = True

                item["children"].append({
                    "kind": "method",
                    "name": stmt.name,
                    "export": False,
                    "defaultExport": False,
                    "async": isinstance(stmt, ast.AsyncFunctionDef),
                    "static": static,
                    "visibility": visibility,
                    "params": get_params(stmt.args),
                    "returnType": expr_to_text(stmt.returns),
                    "startLine": getattr(stmt, "lineno", 0),
                    "endLine": getattr(stmt, "end_lineno", getattr(stmt, "lineno", 0)),
                    "children": extract_nested(stmt.body),
                })

        elif isinstance(stmt, ast.ClassDef):
            item["children"].append(build_class(stmt))

    return item

def extract_nested(body):
    items = []
    for stmt in body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            items.append(build_function(stmt))
        elif isinstance(stmt, ast.ClassDef):
            items.append(build_class(stmt))
    return items

items = extract_nested(tree.body)
print(json.dumps({"items": items}, ensure_ascii=False))
`;

  const pythonCmd = findPythonCommand();
  if (!pythonCmd) {
    console.error("Python runtime not found. Please install python or python3.");
    process.exit(1);
  }

  const res = spawnSync(pythonCmd, ["-c", pyCode, filePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (res.error) {
    console.error(`Failed to run Python: ${res.error.message}`);
    process.exit(1);
  }

  if (res.status !== 0) {
    console.error(res.stderr || "Python parser failed.");
    process.exit(res.status || 1);
  }

  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    console.error("Invalid JSON from Python parser.");
    console.error(res.stdout);
    process.exit(1);
  }
}

function findPythonCommand() {
  for (const cmd of ["python", "python3"]) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

main();