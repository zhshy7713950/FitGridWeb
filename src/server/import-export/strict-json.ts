import { ApiError } from "@/server/http/api-error";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export class JsonNumber {
  constructor(public readonly raw: string) {}
}

class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const result = this.value(0);
    this.whitespace();
    if (this.position !== this.source.length) this.invalid("JSON 包含多余内容");
    return result;
  }

  private value(depth: number): unknown {
    if (depth > 100) this.invalid("JSON 嵌套层级过深");
    this.whitespace();
    const character = this.source[this.position];
    if (character === "{") return this.object(depth + 1);
    if (character === "[") return this.array(depth + 1);
    if (character === '"') return this.string();
    if (this.source.startsWith("true", this.position)) return this.literal("true", true);
    if (this.source.startsWith("false", this.position)) return this.literal("false", false);
    if (this.source.startsWith("null", this.position)) return this.literal("null", null);
    const match = this.source.slice(this.position).match(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/);
    if (match) {
      this.position += match[0].length;
      return new JsonNumber(match[0]);
    }
    return this.invalid("JSON 值无效");
  }

  private object(depth: number): Record<string, unknown> {
    this.position += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.whitespace();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      if (this.source[this.position] !== '"') this.invalid("JSON 对象键必须是字符串");
      const key = this.string();
      if (keys.has(key)) {
        throw new ApiError(400, "JSON_DUPLICATE_KEY", `JSON 包含重复键：${key}`);
      }
      keys.add(key);
      this.whitespace();
      if (this.source[this.position] !== ":") this.invalid("JSON 对象缺少冒号");
      this.position += 1;
      result[key] = this.value(depth);
      this.whitespace();
      const next = this.source[this.position];
      if (next === "}") {
        this.position += 1;
        return result;
      }
      if (next !== ",") this.invalid("JSON 对象缺少逗号");
      this.position += 1;
    }
  }

  private array(depth: number): unknown[] {
    this.position += 1;
    const result: unknown[] = [];
    this.whitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth));
      this.whitespace();
      const next = this.source[this.position];
      if (next === "]") {
        this.position += 1;
        return result;
      }
      if (next !== ",") this.invalid("JSON 数组缺少逗号");
      this.position += 1;
    }
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    let escaped = false;
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (!escaped && character === '"') {
        this.position += 1;
        try {
          return JSON.parse(this.source.slice(start, this.position)) as string;
        } catch {
          return this.invalid("JSON 字符串无效");
        }
      }
      if (character.charCodeAt(0) < 0x20) this.invalid("JSON 字符串包含控制字符");
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      this.position += 1;
    }
    return this.invalid("JSON 字符串未结束");
  }

  private literal<T>(text: string, value: T): T {
    this.position += text.length;
    return value;
  }

  private whitespace(): void {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }

  private invalid(message: string): never {
    throw new ApiError(400, "JSON_INVALID", `${message}（位置 ${this.position}）`);
  }
}

export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ApiError(413, "IMPORT_FILE_TOO_LARGE", "导入文件不能超过 10 MiB");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "JSON_UTF8_INVALID", "导入文件必须是有效 UTF-8");
  }
  return new Parser(source).parse();
}
