export function stripLineComments(source: string, marker: "#" | "//"): string {
  return source
    .split("\n")
    .map((line) => stripLineComment(line, marker))
    .join("\n");
}

export function stripSwiftComments(source: string): string {
  return stripLineComments(stripBlockComments(source), "//");
}

function stripBlockComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      output += "  ";
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          output += "  ";
          depth += 1;
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          depth -= 1;
          index += 2;
          continue;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index -= 1;
    } else {
      output += char;
    }
  }
  return output;
}

function stripLineComment(line: string, marker: "#" | "//"): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (line.startsWith(marker, index)) {
      return line.slice(0, index);
    }
  }
  return line;
}

export function stripXmlComments(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<!--", index);
    if (start === -1) {
      output += source.slice(index);
      break;
    }
    output += source.slice(index, start);
    const end = source.indexOf("-->", start + 4);
    if (end === -1) {
      break;
    }
    index = end + 3;
  }
  return output;
}
