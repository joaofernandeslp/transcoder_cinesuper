export class TranscodeError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "TranscodeError";
    this.meta = meta;
  }
}
