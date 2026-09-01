export class GridDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: keyof import("./types").GridTradeInput,
  ) {
    super(message);
    this.name = "GridDomainError";
  }
}
