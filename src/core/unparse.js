// unparse.js — an expression's text the way MATLAB writes it back for an
// anonymous function (func2str, the handle's display): no blanks around
// operators, commas between arguments and elements, parentheses as typed,
// numbers as typed. @(x) x.^2 + 1 is shown as @(x)x.^2+1.

export function unparse(node) {
  switch (node.type) {
    case 'Num': case 'ImagNum': return node.raw ?? String(node.value) + (node.type === 'ImagNum' ? 'i' : '');
    case 'Str': return `'${node.value.replace(/'/g, "''")}'`;
    case 'Ident': return node.name;
    case 'End': return 'end';
    case 'FullColon': return ':';
    case 'Paren': return `(${unparse(node.expr)})`;
    case 'Binary': return `${unparse(node.left)}${node.op}${unparse(node.right)}`;
    case 'Unary': return `${node.op}${unparse(node.expr)}`;
    case 'Transpose': return `${unparse(node.expr)}${node.conjugate ? "'" : ".'"}`;
    case 'Range': return [node.start, node.step, node.stop].filter(Boolean).map(unparse).join(':');
    case 'Index': return `${unparse(node.target)}(${node.args.map(unparse).join(',')})`;
    case 'CellIndex': return `${unparse(node.target)}{${node.args.map(unparse).join(',')}}`;
    case 'Field': return `${unparse(node.target)}.${node.name}`;
    case 'DynField': return `${unparse(node.target)}.(${unparse(node.nameExpr)})`;
    case 'MatrixLit': return `[${node.rows.map(r => r.map(unparse).join(',')).join(';')}]`;
    case 'CellLit': return `{${node.rows.map(r => r.map(unparse).join(',')).join(';')}}`;
    case 'AnonFunc': return `@(${node.params.join(',')})${unparse(node.body)}`;
    case 'FuncHandle': return `@${node.name}`;
    default: return node.source ?? '?';
  }
}
