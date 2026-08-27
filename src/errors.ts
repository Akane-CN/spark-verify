export class ManifestError extends Error {
  readonly source: string;

  constructor(source: string, message: string, options?: ErrorOptions) {
    super(`${source}: ${message}`, options);
    this.name = "ManifestError";
    this.source = source;
  }
}
