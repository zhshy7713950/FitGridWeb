import { describe, expect, it } from "vitest";
import { authorizeTask } from "./runtime";
describe("private task authentication", () => {
  const secret = "task-secret-" + "a".repeat(48);
  it("fails closed when configuration missing, or caller only has a session cookie", () => {
    expect(() => authorizeTask(new Request("http://127.0.0.1/task"), "")).toThrow(/配置/);
    expect(() => authorizeTask(new Request("http://127.0.0.1/task", { headers: { cookie: "session=administrator" } }), secret)).toThrow(/拒绝/);
    expect(() => authorizeTask(new Request(`http://127.0.0.1/task?secret=${secret}`), secret)).toThrow(/拒绝/);
  });
  it("accepts only the exact Bearer token supplied in a header", () => {
    expect(() => authorizeTask(new Request("http://127.0.0.1/task", { headers: { authorization: `Bearer ${secret}` } }), secret)).not.toThrow();
    expect(() => authorizeTask(new Request("http://127.0.0.1/task", { headers: { authorization: `Bearer ${secret}x` } }), secret)).toThrow(/拒绝/);
  });
});
